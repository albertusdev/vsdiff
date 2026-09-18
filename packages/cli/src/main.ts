#!/usr/bin/env node
// vsdiff CLI — P1 verbs: guide, validate, new. P2 adds the feedback loop:
// open --await, feedback [--wait], reply, resolve, comment. Later phases add
// config, pr, mcp (blueprint §8). This file stays a dispatcher: the logic lives
// in session-dir.ts, feedback-cmd.ts, await-cmd.ts, format.ts, launch.ts.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadConfig } from '@vsdiff/core';
import { getJsonSchema, validateSession, type SessionSource } from '@vsdiff/schema';
import { awaitResult, clearResult, exitCodeForStatus } from './await-cmd.ts';
import {
  appendComment,
  appendReply,
  appendResolve,
  collectFeedback,
  DEFAULT_WAIT_TIMEOUT_MS,
} from './feedback-cmd.ts';
import { numberFlag, parseFlags, requireIntFlag, requireStringFlag, stringFlag } from './flags.ts';
import { formatBatch } from './format.ts';
import { launchEditor } from './launch.ts';
import { configReport, renderConfigReport } from './config-cmd.ts';
import { prPublish, prPull, prStart } from './pr-cmd.ts';
import { runInit } from './init-cmd.ts';
import { runMcpStdio } from './mcp/server.ts';
import { inventorySource, formatNewSummary, scaffoldSession } from './new-cmd.ts';
import { findRepoRoot, resolveSessionDir } from './session-dir.ts';

import { VERSION } from './version.ts';

const HELP = `vsdiff ${VERSION} — agent-first guided code review for VS Code

Usage:
  vsdiff guide [--schema]        print the Review Session authoring guide (or the JSON Schema)
  vsdiff validate <file>         strict-check a session file; exit 1 with fix hints on errors
  vsdiff new [options]           scaffold a session + print the diffstat to author against
    --base <ref> --head <ref>      range source (default)
    --staged | --working-tree      local sources
    --commit <ref>                 single commit source
    --title <text>                 session title
    --json                         machine-readable output
  vsdiff open [--await]          open the editor on the session (best effort)
  vsdiff web [status|stop]       the serve-web daemon behind editor: "web"
    --await                        block until the human finishes; prints result.json, exit 2 if canceled
    --timeout <sec>                give up waiting (default 0 = forever) → canceled, exit 2
  vsdiff diffstat [--json]       read-only hunk inventory (what 'new' prints, no writes)
  vsdiff config [--json]         show merged config, paths, and the resolved editor
  vsdiff init [--skill claude]   set a repo up: gitignore, .mcp.json, packaged skill
  vsdiff mcp                     serve the review verbs as MCP tools on stdio
  vsdiff pr <number>             GitHub mode: checkout the PR + scaffold a SHA-pinned session
  vsdiff pr publish [--event approve|request-changes|comment] [--body <text>]
                                 project unposted threads to the PR as one pending review
  vsdiff pr pull                 import new PR comments as feedback events
  vsdiff feedback [options]      read the review events the human left
    --after <n>                    resume from a previous read's \`next\` cursor (default 0)
    --json                         print the raw batch: { events, nextLine, malformed }
    --wait                         block until new events arrive; exit 3 if none in time
    --timeout <sec>                wait budget (default 300)
  vsdiff reply --thread <id> --body <text>             append an agent reply to a thread
  vsdiff resolve --thread <id>                         mark a thread resolved by the agent
  vsdiff comment --path <p> --line <n> --body <text> [--stop <id>]
                                                       open an agent-authored thread
  vsdiff --version | --help

Every P2 verb takes --session <dir>; the default is the newest .vsdiff/sessions/*/session.json.
Exit codes: 0 ok · 1 invalid session · 2 usage error or review canceled · 3 feedback wait timed out.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function readGuide(): Promise<string> {
  const guidePath = fileURLToPath(import.meta.resolve('@vsdiff/schema/guide.md'));
  return readFile(guidePath, 'utf8');
}

function sourceFromFlags(flags: Map<string, string | true>): SessionSource {
  if (flags.has('staged')) return { type: 'staged' };
  if (flags.has('working-tree')) return { type: 'working-tree' };
  const commit = flags.get('commit');
  if (typeof commit === 'string') return { type: 'commit', head: commit };
  const base = flags.get('base');
  const head = flags.get('head');
  if (typeof base === 'string') {
    return { type: 'range', base, head: typeof head === 'string' ? head : 'HEAD' };
  }
  return { type: 'working-tree' };
}

async function cmdValidate(file: string | undefined): Promise<number> {
  if (!file) fail('vsdiff validate: missing <file>');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    fail(`vsdiff validate: cannot read ${file}: ${(error as Error).message}`);
  }
  const result = validateSession(raw);
  if (result.ok) {
    process.stdout.write(`OK: ${file} — "${result.session.title}"\n`);
    return 0;
  }
  process.stderr.write(`INVALID: ${file} — ${result.errors.length} issue(s)\n\n`);
  for (const issue of result.errors) {
    process.stderr.write(`  ${issue.path}\n    ${issue.message}\n`);
    if (issue.hint) process.stderr.write(`    fix: ${issue.hint}\n`);
    process.stderr.write('\n');
  }
  return 1;
}

async function cmdNew(flags: Map<string, string | true>): Promise<number> {
  const result = await scaffoldSession({
    repoRoot: process.cwd(),
    source: sourceFromFlags(flags),
    title: typeof flags.get('title') === 'string' ? (flags.get('title') as string) : 'Review',
  });
  process.stdout.write(
    flags.has('json') ? `${JSON.stringify(result.payload, null, 2)}\n` : formatNewSummary(result),
  );
  return 0;
}

type Flags = Map<string, string | true>;

function sessionDirFrom(flags: Flags): Promise<string> {
  return resolveSessionDir(stringFlag(flags, 'session'), process.cwd());
}

async function cmdFeedback(flags: Flags): Promise<number> {
  const sessionDir = await sessionDirFrom(flags);
  const { batch, timedOut } = await collectFeedback(sessionDir, {
    after: numberFlag(flags, 'after', 0),
    wait: flags.has('wait'),
    timeoutMs: numberFlag(flags, 'timeout', DEFAULT_WAIT_TIMEOUT_MS / 1000) * 1000,
  });
  process.stdout.write(
    flags.has('json') ? `${JSON.stringify(batch, null, 2)}\n` : formatBatch(batch),
  );
  return timedOut ? 3 : 0;
}

async function cmdReply(flags: Flags): Promise<number> {
  const sessionDir = await sessionDirFrom(flags);
  const event = await appendReply(sessionDir, {
    thread: requireStringFlag(flags, 'thread'),
    body: requireStringFlag(flags, 'body'),
  });
  process.stdout.write(`replied to ${event.thread} in ${sessionDir}\n`);
  return 0;
}

async function cmdResolve(flags: Flags): Promise<number> {
  const sessionDir = await sessionDirFrom(flags);
  const event = await appendResolve(sessionDir, { thread: requireStringFlag(flags, 'thread') });
  process.stdout.write(`resolved ${event.thread} in ${sessionDir}\n`);
  return 0;
}

async function cmdComment(flags: Flags): Promise<number> {
  const sessionDir = await sessionDirFrom(flags);
  const event = await appendComment(sessionDir, {
    path: requireStringFlag(flags, 'path'),
    line: requireIntFlag(flags, 'line'),
    body: requireStringFlag(flags, 'body'),
    stop: stringFlag(flags, 'stop'),
  });
  process.stdout.write(`opened ${event.id} at ${event.path}:${event.line}\n`);
  return 0;
}

async function cmdOpen(flags: Flags): Promise<number> {
  const sessionDir = await sessionDirFrom(flags);
  const repoRoot = (await findRepoRoot(sessionDir)) ?? process.cwd();

  if (!flags.has('await')) {
    await launchEditor(repoRoot);
    process.stdout.write(`${sessionDir}\n`);
    return 0;
  }

  const timeoutMs = numberFlag(flags, 'timeout', 0) * 1000;
  // Clear before the editor starts, so a result written by this review can't be
  // mistaken for the stale one (awaitResult clears again as its own guarantee).
  await clearResult(sessionDir);
  await launchEditor(repoRoot);
  process.stderr.write(
    `waiting for review in ${sessionDir}${timeoutMs > 0 ? ` (timeout ${timeoutMs / 1000}s)` : ''}\n`,
  );
  const result = await awaitResult(sessionDir, { timeoutMs });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return exitCodeForStatus(result.status);
}

/** P2 verbs report bad flags and missing sessions as messages, not stacks. */
async function guarded(command: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    fail(`vsdiff ${command}: ${(error as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;

    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case 'guide':
      if (flags.has('schema')) {
        process.stdout.write(`${JSON.stringify(getJsonSchema(), null, 2)}\n`);
      } else {
        process.stdout.write(await readGuide());
      }
      return 0;

    case 'validate':
      return cmdValidate(positional[0]);

    case 'new':
      return cmdNew(flags);

    case 'diffstat':
      return guarded('diffstat', async () => {
        const inventory = await inventorySource(process.cwd(), sourceFromFlags(flags));
        if (flags.has('json')) {
          process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
        } else {
          const { diffstat: stats } = inventory;
          process.stdout.write(
            `Diffstat: ${stats.files} files, ${stats.hunks} hunks, +${stats.additions} -${stats.deletions}\n` +
              inventory.files
                .map(
                  (f) =>
                    `  ${f.status.charAt(0).toUpperCase()} ${f.path}${f.binary ? ' (binary)' : ''} — ${f.hunks} ${f.hunks === 1 ? 'hunk' : 'hunks'} [${f.hunkIds.map((id) => id.slice(id.lastIndexOf(':') + 1)).join(',')}]`,
                )
                .join('\n') +
              '\n',
          );
        }
        return 0;
      });

    case 'open':
      return guarded('open', () => cmdOpen(flags));

    case 'feedback':
      return guarded('feedback', () => cmdFeedback(flags));

    case 'reply':
      return guarded('reply', () => cmdReply(flags));

    case 'resolve':
      return guarded('resolve', () => cmdResolve(flags));

    case 'comment':
      return guarded('comment', () => cmdComment(flags));

    case 'pr':
      return guarded('pr', async () => {
        const sub = positional[0];
        const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
        if (sub !== undefined && /^\d+$/.test(sub)) {
          const started = await prStart(repoRoot, Number(sub));
          process.stdout.write(started.summary);
          return 0;
        }
        if (sub === 'publish') {
          const sessionDir = await sessionDirFrom(flags);
          const eventFlag = flags.get('event');
          const event =
            eventFlag === 'approve'
              ? ('APPROVE' as const)
              : eventFlag === 'request-changes'
                ? ('REQUEST_CHANGES' as const)
                : ('COMMENT' as const);
          const body = flags.get('body');
          const published = await prPublish(repoRoot, sessionDir, {
            event,
            ...(typeof body === 'string' ? { body } : {}),
          });
          process.stdout.write(`${JSON.stringify(published, null, 2)}\n`);
          return 0;
        }
        if (sub === 'pull') {
          const sessionDir = await sessionDirFrom(flags);
          const pulled = await prPull(repoRoot, sessionDir);
          process.stdout.write(`${JSON.stringify(pulled, null, 2)}\n`);
          return 0;
        }
        process.stderr.write('vsdiff pr: expected <number>, publish, or pull\n');
        return 2;
      });

    case 'web':
      return guarded('web', async () => {
        const { daemonStatus, stopDaemon, webSettings } = await import('./web-launch.ts');
        const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
        const { config } = await loadConfig(repoRoot);
        const settings = webSettings(config);
        const sub = positional[0] ?? 'status';
        if (sub === 'status') {
          process.stdout.write(`${await daemonStatus(settings)}\n`);
          return 0;
        }
        if (sub === 'stop') {
          stopDaemon(settings);
          process.stdout.write(`stopped serve-web on port ${settings.port}\n`);
          return 0;
        }
        process.stderr.write('vsdiff web: expected status or stop\n');
        return 2;
      });

    case 'config': {
      const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
      const report = await configReport(repoRoot);
      process.stdout.write(
        flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderConfigReport(report),
      );
      return 0;
    }

    case 'init': {
      const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
      const skill = flags.get('skill');
      const result = await runInit(repoRoot, typeof skill === 'string' ? { skill } : {});
      for (const action of result.actions) process.stdout.write(`${action}\n`);
      return 0;
    }

    case 'mcp':
      return runMcpStdio({ cwd: process.cwd() });

    default:
      process.stderr.write(`vsdiff: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));

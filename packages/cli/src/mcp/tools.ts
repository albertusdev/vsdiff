// The MCP tool surface (blueprint §7.3, D4): the review verbs as tools, over the
// same core/CLI functions the command line calls — no shelling out, no second
// implementation. Nothing here writes to stdout: that channel belongs to the
// JSON-RPC framing in ./server.ts.
//
// Every failure an agent can fix (bad arguments, no session, a bad ref) is a
// `ToolError` whose message says what to send instead; ./server.ts turns those
// into `isError` results rather than letting them kill the server.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadSessionFile, readResult } from '@vsdiff/core';
import { getJsonSchema, validateSession, type SessionSource } from '@vsdiff/schema';
import { awaitResult } from '../await-cmd.ts';
import {
  appendComment,
  appendReply,
  appendResolve,
  collectFeedback,
  DEFAULT_WAIT_TIMEOUT_MS,
} from '../feedback-cmd.ts';
import { inventorySource, scaffoldSession } from '../new-cmd.ts';
import { findRepoRoot, resolveSessionDir, SessionDirError } from '../session-dir.ts';

/** A failure the caller can fix from the message alone. */
export class ToolError extends Error {
  override readonly name = 'ToolError';
}

export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: readonly string[];
  minimum?: number;
  minLength?: number;
}

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: readonly string[];
  additionalProperties: false;
}

/** Text is handed back verbatim (the guide is markdown); everything else is JSON. */
export type ToolOutput = { kind: 'text'; text: string } | { kind: 'json'; value: unknown };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const json = (value: unknown): ToolOutput => ({ kind: 'json', value });
const text = (value: string): ToolOutput => ({ kind: 'text', text: value });

// ---------------------------------------------------------------- arguments

/**
 * Argument checking reads the tool's own `inputSchema`, so what `tools/list`
 * advertises and what the tool accepts can't drift apart. Only the subset of
 * JSON Schema the tools use is implemented: typed scalars, enums, minimums,
 * required keys, no extra keys.
 */
export function checkArgs(tool: McpTool, raw: unknown): Record<string, unknown> {
  const args = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(args)) {
    throw new ToolError(`${tool.name}: "arguments" must be a JSON object, e.g. {}`);
  }
  const { properties } = tool.inputSchema;
  const known = Object.keys(properties);
  for (const key of Object.keys(args)) {
    if (!(key in properties)) {
      throw new ToolError(
        `${tool.name}: unknown argument "${key}" — this tool takes ${known.length === 0 ? 'no arguments' : known.join(', ')}`,
      );
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) {
      throw new ToolError(
        `${tool.name}: missing required argument "${key}" — ${properties[key]?.description ?? ''}`,
      );
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) checkValue(tool.name, key, properties[key]!, value);
  }
  return args;
}

function checkValue(tool: string, key: string, spec: PropertySchema, value: unknown): void {
  const bad = (want: string): ToolError =>
    new ToolError(
      `${tool}: "${key}" must be ${want}, got ${JSON.stringify(value) ?? typeof value}`,
    );

  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('true or false');
      return;
    case 'string':
      if (typeof value !== 'string') throw bad('a string');
      if (value.length < (spec.minLength ?? 0)) throw bad('a non-empty string');
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        throw bad(`one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`);
      }
      return;
    case 'integer':
    case 'number': {
      const kind = spec.type === 'integer' ? 'an integer' : 'a number';
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(kind);
      if (spec.type === 'integer' && !Number.isInteger(value)) throw bad(kind);
      if (spec.minimum !== undefined && value < spec.minimum)
        throw bad(`${kind} >= ${spec.minimum}`);
      return;
    }
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' ? value : fallback;
}

const bool = (args: Record<string, unknown>, key: string): boolean => args[key] === true;

// ------------------------------------------------------------- shared pieces

const SESSION_PROP: PropertySchema = {
  type: 'string',
  minLength: 1,
  description:
    'Session directory to act on (or its session.json). Defaults to the newest .vsdiff/sessions/* at or above the working directory.',
};

const REPO_SESSION_PROP: PropertySchema = {
  type: 'string',
  minLength: 1,
  description:
    'Find the repository from this session directory instead of from the working directory.',
};

const SOURCE_PROPS: Record<string, PropertySchema> = {
  type: {
    type: 'string',
    enum: ['working-tree', 'staged', 'commit', 'range'],
    description:
      'What to diff. Defaults to "commit" when `commit` is given, "range" when `base` is given, else "working-tree".',
  },
  base: { type: 'string', minLength: 1, description: 'Range source: the ref to diff from.' },
  head: {
    type: 'string',
    minLength: 1,
    description: 'Range source: the ref to diff to (default "HEAD").',
  },
  commit: { type: 'string', minLength: 1, description: 'Commit source: the single ref to review.' },
};

/** The CLI's `--session` translated: same resolver, MCP-shaped fix instructions. */
async function sessionDirFor(cwd: string, args: Record<string, unknown>): Promise<string> {
  try {
    return await resolveSessionDir(str(args, 'session'), cwd);
  } catch (error) {
    if (error instanceof SessionDirError) {
      throw new ToolError(
        `${error.message}\nOver MCP the CLI's --session flag is the "session" argument: {"session": "<path to the session directory>"}.`,
      );
    }
    throw error;
  }
}

async function repoRootFor(cwd: string, args: Record<string, unknown>): Promise<string> {
  const start = str(args, 'session') === undefined ? cwd : await sessionDirFor(cwd, args);
  const root = await findRepoRoot(start);
  if (root === null) {
    throw new ToolError(
      `no git repository at or above ${start} — start the server with its working directory inside the repo under review, or pass "session" pointing into it.`,
    );
  }
  return root;
}

/** Mirrors the CLI's flag defaulting: an explicit type wins, then commit, then base. */
function sourceFromArgs(tool: string, args: Record<string, unknown>): SessionSource {
  const type = str(args, 'type');
  const base = str(args, 'base');
  const head = str(args, 'head');
  const commit = str(args, 'commit');

  if (type === 'staged' || type === 'working-tree') return { type };
  if (type === 'commit') {
    if (commit === undefined) {
      throw new ToolError(
        `${tool}: type "commit" needs "commit" — the ref to review, e.g. "HEAD".`,
      );
    }
    return { type: 'commit', head: commit };
  }
  if (type === 'range') {
    if (base === undefined) {
      throw new ToolError(
        `${tool}: type "range" needs "base" — the ref to diff from, e.g. "main".`,
      );
    }
    return { type: 'range', base, head: head ?? 'HEAD' };
  }
  if (commit !== undefined) return { type: 'commit', head: commit };
  if (base !== undefined) return { type: 'range', base, head: head ?? 'HEAD' };
  return { type: 'working-tree' };
}

async function readGuide(): Promise<string> {
  const guidePath = fileURLToPath(import.meta.resolve('@vsdiff/schema/guide.md'));
  return readFile(guidePath, 'utf8');
}

// -------------------------------------------------------------------- tools

export interface ToolContext {
  /** Working directory every path and session lookup is relative to. */
  cwd: string;
}

export function createTools(context: ToolContext): McpTool[] {
  const { cwd } = context;

  return [
    {
      name: 'vsdiff_guide',
      description:
        'The Review Session authoring guide (markdown): how to write session.json — chapters, stops, hunk anchors, length budgets. Pass schema=true for the JSON Schema instead. Read this before authoring a session.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: {
            type: 'boolean',
            description: 'Return the JSON Schema instead of the prose guide.',
          },
        },
        additionalProperties: false,
      },
      async run(args) {
        return bool(args, 'schema') ? json(getJsonSchema()) : text(await readGuide());
      },
    },

    {
      name: 'vsdiff_diffstat',
      description:
        'Diffstat plus the per-file hunk inventory (the hunk ids stops anchor to) for a source, writing nothing. Use it to look before scaffolding.',
      inputSchema: {
        type: 'object',
        properties: { ...SOURCE_PROPS, session: REPO_SESSION_PROP },
        additionalProperties: false,
      },
      async run(args) {
        const repoRoot = await repoRootFor(cwd, args);
        return json(await inventorySource(repoRoot, sourceFromArgs('vsdiff_diffstat', args)));
      },
    },

    {
      name: 'vsdiff_new',
      description:
        'Scaffold .vsdiff/sessions/<date>-<slug>/session.json for a new review and return its path, the diffstat, and every file with its hunk ids. Author chapters/stops into that file next, then vsdiff_validate.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, description: 'Session title (names the folder).' },
          ...SOURCE_PROPS,
          session: REPO_SESSION_PROP,
        },
        required: ['title'],
        additionalProperties: false,
      },
      async run(args) {
        const repoRoot = await repoRootFor(cwd, args);
        const result = await scaffoldSession({
          repoRoot,
          source: sourceFromArgs('vsdiff_new', args),
          title: str(args, 'title') ?? 'Review',
        });
        return json(result.payload);
      },
    },

    {
      name: 'vsdiff_validate',
      description:
        'Strict-check a session file. Returns {ok:true} or {ok:false, errors:[{path,message,hint}]} — every error says what to write instead.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            minLength: 1,
            description: 'Path to session.json (absolute, or relative to the working directory).',
          },
        },
        required: ['file'],
        additionalProperties: false,
      },
      async run(args) {
        const file = resolve(cwd, str(args, 'file') ?? '');
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          throw new ToolError(
            `cannot read ${file}: ${(error as Error).message} — pass an absolute path, or one relative to ${cwd}.`,
          );
        }
        const result = validateSession(raw);
        return json(
          result.ok
            ? { ok: true, file, title: result.session.title }
            : { ok: false, file, errors: result.errors },
        );
      },
    },

    {
      name: 'vsdiff_feedback',
      description:
        'Read the review events the human left (comments, replies, verdicts, viewed marks, done). Pass after=<the nextLine of your last read> to resume, wait=true to block until something new arrives.',
      inputSchema: {
        type: 'object',
        properties: {
          after: {
            type: 'integer',
            minimum: 0,
            description: 'Resume cursor: the `nextLine` a previous read returned.',
          },
          wait: { type: 'boolean', description: 'Block until new events arrive.' },
          timeoutSec: {
            type: 'number',
            minimum: 0,
            description: `Wait budget in seconds (default ${DEFAULT_WAIT_TIMEOUT_MS / 1000}); \`timedOut: true\` comes back when it runs out.`,
          },
          session: SESSION_PROP,
        },
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        const wait = bool(args, 'wait');
        const { batch, timedOut } = await collectFeedback(sessionDir, {
          after: num(args, 'after', 0),
          wait,
          timeoutMs: num(args, 'timeoutSec', DEFAULT_WAIT_TIMEOUT_MS / 1000) * 1000,
        });
        return json(wait ? { ...batch, timedOut } : batch);
      },
    },

    {
      name: 'vsdiff_reply',
      description:
        'Append an agent reply to a comment thread; it lands live in the open editor thread.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', minLength: 1, description: 'Thread id from vsdiff_feedback.' },
          body: { type: 'string', minLength: 1, description: 'Reply text.' },
          session: SESSION_PROP,
        },
        required: ['thread', 'body'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        const event = await appendReply(sessionDir, {
          thread: str(args, 'thread') ?? '',
          body: str(args, 'body') ?? '',
        });
        return json({ ok: true, thread: event.thread });
      },
    },

    {
      name: 'vsdiff_resolve',
      description: 'Mark a comment thread resolved by the agent.',
      inputSchema: {
        type: 'object',
        properties: {
          thread: { type: 'string', minLength: 1, description: 'Thread id from vsdiff_feedback.' },
          session: SESSION_PROP,
        },
        required: ['thread'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        const event = await appendResolve(sessionDir, { thread: str(args, 'thread') ?? '' });
        return json({ ok: true, thread: event.thread });
      },
    },

    {
      name: 'vsdiff_comment',
      description:
        'Open an agent-authored comment thread on a file line — how to ask the human a question during a review.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Repo-relative file path.' },
          line: { type: 'integer', minimum: 1, description: '1-based line number.' },
          body: { type: 'string', minLength: 1, description: 'Comment text.' },
          stop: {
            type: 'string',
            minLength: 1,
            description: 'Stop id this belongs to (optional).',
          },
          session: SESSION_PROP,
        },
        required: ['path', 'line', 'body'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        const event = await appendComment(sessionDir, {
          path: str(args, 'path') ?? '',
          line: num(args, 'line', 1),
          body: str(args, 'body') ?? '',
          stop: str(args, 'stop'),
        });
        return json({ ok: true, thread: event.id });
      },
    },

    {
      name: 'vsdiff_await',
      description:
        'Block until the human finishes the review, then return the result document (approved | changes-requested | closed | canceled). Any earlier result is deleted first, so this never resolves on a stale one. Waits forever unless timeoutSec is given, and the server answers one call at a time — nothing else runs while this waits.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutSec: {
            type: 'number',
            minimum: 0,
            description: 'Give up after this many seconds (default 0 = wait forever) → canceled.',
          },
          session: SESSION_PROP,
        },
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        return json(
          await awaitResult(sessionDir, { timeoutMs: num(args, 'timeoutSec', 0) * 1000 }),
        );
      },
    },

    {
      name: 'vsdiff_status',
      description:
        'Where the review stands: the session directory in use, its title and source, and the result document once the human has finished (null until then).',
      inputSchema: {
        type: 'object',
        properties: { session: SESSION_PROP },
        additionalProperties: false,
      },
      async run(args) {
        const sessionDir = await sessionDirFor(cwd, args);
        const parsed = await loadSessionFile(join(sessionDir, 'session.json'));
        return json({
          sessionDir,
          ...(parsed.ok
            ? { title: parsed.session.title, source: parsed.session.source }
            : { unreadable: parsed.errors }),
          result: await readResult(sessionDir),
        });
      },
    },
  ];
}

/** Default context: the process the server runs in. */
export function defaultTools(): McpTool[] {
  return createTools({ cwd: process.cwd() });
}

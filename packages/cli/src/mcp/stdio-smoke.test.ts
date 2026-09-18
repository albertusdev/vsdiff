// The one test that exercises the real thing: the built CLI, spawned as
// `vsdiff mcp`, talked to over a pipe. Everything else drives handleLine
// directly — this is what proves the framing (one JSON line per response,
// nothing else on stdout) and the clean shutdown when the client closes stdin.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const CLI_PKG = resolve(fileURLToPath(import.meta.url), '../../..');
const CLI = join(CLI_PKG, 'dist', 'main.mjs');
const TSDOWN = join(CLI_PKG, 'node_modules', '.bin', 'tsdown');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function feed(cwd: string, lines: string[]): Promise<Run> {
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  child.stdin.end(lines.map((line) => `${line}\n`).join(''));
  return new Promise<Run>((resolveRun, rejectRun) => {
    child.on('error', rejectRun);
    child.on('close', (code) =>
      resolveRun({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

test(
  'the built CLI serves MCP over stdio and exits 0 when stdin closes',
  { timeout: 60_000 },
  async () => {
    execFileSync(TSDOWN, ['src/main.ts', '--format', 'esm', '--out-dir', 'dist'], {
      cwd: CLI_PKG,
      stdio: 'ignore',
    });
    const repo = mkdtempSync(join(tmpdir(), 'vsdiff-mcp-smoke-'));
    tempRoots.push(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

    const run = await feed(repo, [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'vsdiff_guide' },
      }),
    ]);

    expect(run.code).toBe(0);

    // One line per response, and nothing else on stdout — the notification is silent.
    const lines = run.stdout.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    const [initialize, list, guide] = lines.map(
      (line) => JSON.parse(line) as Record<string, never>,
    );

    expect(initialize).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'vsdiff', version: '0.0.1' },
      },
    });

    const tools = (list['result'] as unknown as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain('vsdiff_guide');
    expect(tools).toHaveLength(10);

    const content = (guide['result'] as unknown as { content: Array<{ text: string }> }).content;
    expect(content[0]?.text).toContain('# Review Session — authoring guide');

    // Logs went to stderr, where they cannot desync the client's parser.
    expect(run.stderr).toContain('vsdiff mcp: serving 10 tools on stdio');
  },
);

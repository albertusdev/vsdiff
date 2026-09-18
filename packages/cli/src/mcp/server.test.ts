import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { readFeedback, type CommentEvent } from '@vsdiff/core';
import { createMcpServer, PROTOCOL_VERSION, type McpServer } from './server.ts';
import type { McpTool } from './tools.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

const SESSION = {
  version: 1,
  kind: 'review',
  title: 'Payments refactor',
  focus: '',
  source: { type: 'working-tree' },
  chapters: [],
};

interface Workspace {
  root: string;
  sessionDir: string;
  server: McpServer;
}

/** A workspace holding one session, plus a server rooted at it. */
function makeWorkspace(session: unknown = SESSION): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-mcp-'));
  tempRoots.push(root);
  const sessionDir = join(root, '.vsdiff', 'sessions', '2026-08-19-payments');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
  return { root, sessionDir, server: makeServer(root) };
}

function makeServer(cwd: string): McpServer {
  return createMcpServer({ cwd, log: () => {} });
}

interface RpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  isError: boolean;
  text: string;
}

async function rpc(server: McpServer, message: unknown): Promise<RpcResponse | null> {
  const line = await server.handleLine(JSON.stringify(message));
  return line === null ? null : (JSON.parse(line) as RpcResponse);
}

async function call(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
): Promise<ToolResult> {
  const response = await rpc(server, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = response?.result as
    | { content: Array<{ type: string; text: string }>; isError: boolean }
    | undefined;
  if (result === undefined) throw new Error(`no result: ${JSON.stringify(response)}`);
  expect(result.content[0]?.type).toBe('text');
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}

const payloadOf = (result: ToolResult): unknown => JSON.parse(result.text);

// -------------------------------------------------------------- handshake

test('initialize echoes the client protocol version and announces the tools capability', async () => {
  const { server } = makeWorkspace();

  const response = await rpc(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe' } },
  });

  expect(response?.result).toEqual({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'vsdiff', version: '0.0.1' },
  });
});

test('initialize without a requested version falls back to the built-in one', async () => {
  const { server } = makeWorkspace();

  const response = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  expect(response?.result?.['protocolVersion']).toBe(PROTOCOL_VERSION);
});

test('notifications get no response at all, and ping answers with an empty result', async () => {
  const { server } = makeWorkspace();

  expect(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBe(
    null,
  );
  expect(await server.handleLine('   ')).toBe(null);
  expect((await rpc(server, { jsonrpc: '2.0', id: 7, method: 'ping' }))?.result).toEqual({});
});

// -------------------------------------------------------------- tools/list

test('tools/list advertises every verb with a usable JSON Schema', async () => {
  const { server } = makeWorkspace();

  const response = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = response?.result?.['tools'] as Array<{
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
      additionalProperties: boolean;
    };
  }>;

  expect(tools.map((t) => t.name)).toEqual([
    'vsdiff_guide',
    'vsdiff_diffstat',
    'vsdiff_new',
    'vsdiff_validate',
    'vsdiff_feedback',
    'vsdiff_reply',
    'vsdiff_resolve',
    'vsdiff_comment',
    'vsdiff_await',
    'vsdiff_status',
  ]);
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const [key, property] of Object.entries(tool.inputSchema.properties)) {
      expect(property.type, `${tool.name}.${key}`).toMatch(/^(string|number|integer|boolean)$/);
      expect(property.description.length, `${tool.name}.${key}`).toBeGreaterThan(0);
    }
    for (const key of tool.inputSchema.required ?? []) {
      expect(Object.keys(tool.inputSchema.properties), `${tool.name} required`).toContain(key);
    }
  }
  expect(tools.find((t) => t.name === 'vsdiff_comment')?.inputSchema.required).toEqual([
    'path',
    'line',
    'body',
  ]);
});

// --------------------------------------------------------------- the tools

test('vsdiff_guide returns the authoring guide, or the schema on request', async () => {
  const { server } = makeWorkspace();

  const guide = await call(server, 'vsdiff_guide');
  expect(guide.isError).toBe(false);
  expect(guide.text).toContain('# Review Session — authoring guide');

  const schema = await call(server, 'vsdiff_guide', { schema: true });
  const parsed = payloadOf(schema) as { $id: string; title: string };
  expect(parsed.$id).toContain('review-session');
  expect(parsed.title).toContain('Review Session');
});

test('vsdiff_validate reports ok, and reports every issue with a fix hint', async () => {
  const { root, sessionDir, server } = makeWorkspace();

  const good = await call(server, 'vsdiff_validate', { file: join(sessionDir, 'session.json') });
  expect(good.isError).toBe(false);
  expect(payloadOf(good)).toMatchObject({ ok: true, title: 'Payments refactor' });

  const badFile = join(root, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ version: 2, kind: 'notes', title: '', source: {} }));
  const bad = await call(server, 'vsdiff_validate', { file: 'bad.json' });
  const payload = payloadOf(bad) as { ok: boolean; errors: Array<{ path: string; hint?: string }> };

  expect(bad.isError).toBe(false); // a wrong session is an answer, not a tool failure
  expect(payload.ok).toBe(false);
  expect(payload.errors.map((e) => e.path)).toContain('version');
  expect(payload.errors.every((e) => typeof e.hint === 'string')).toBe(true);
});

test('vsdiff_validate on a missing file is an isError result naming the path', async () => {
  const { root, server } = makeWorkspace();

  const missing = await call(server, 'vsdiff_validate', { file: 'nope.json' });

  expect(missing.isError).toBe(true);
  expect(missing.text).toContain(join(root, 'nope.json'));
  expect(missing.text).toContain('relative to');
});

test('comment, reply and resolve land in the session log and read back through feedback', async () => {
  const { sessionDir, server } = makeWorkspace();

  const opened = await call(server, 'vsdiff_comment', {
    path: 'src/api/client.ts',
    line: 38,
    body: 'Is the retry budget covered by a test?',
    stop: 'retry-budget',
  });
  const thread = (payloadOf(opened) as { ok: boolean; thread: string }).thread;
  expect(opened.isError).toBe(false);
  expect(thread).toMatch(/^t\d+-[0-9a-f]{4}$/);

  expect(
    payloadOf(await call(server, 'vsdiff_reply', { thread, body: 'Added in case 7.' })),
  ).toEqual({ ok: true, thread });
  expect(payloadOf(await call(server, 'vsdiff_resolve', { thread }))).toEqual({ ok: true, thread });

  const batch = payloadOf(await call(server, 'vsdiff_feedback')) as {
    events: Array<{ type: string }>;
    nextLine: number;
    malformed: number;
  };
  expect(batch.events.map((e) => e.type)).toEqual(['comment', 'reply', 'resolve']);
  expect(batch.nextLine).toBe(3);
  expect(batch.malformed).toBe(0);
  expect((batch.events[0] as CommentEvent).stop).toBe('retry-budget');

  // …and the same events are on disk in the session the server picked.
  const onDisk = await readFeedback(sessionDir);
  expect(onDisk.events).toHaveLength(3);

  // A resume cursor returns nothing new.
  const resumed = payloadOf(
    await call(server, 'vsdiff_feedback', { after: batch.nextLine }),
  ) as typeof batch;
  expect(resumed.events).toEqual([]);
});

test('vsdiff_feedback --wait reports timedOut instead of hanging forever', async () => {
  const { server } = makeWorkspace();

  const payload = payloadOf(
    await call(server, 'vsdiff_feedback', { wait: true, timeoutSec: 0.05 }),
  ) as { events: unknown[]; timedOut: boolean };

  expect(payload).toMatchObject({ events: [], timedOut: true });
});

test('vsdiff_status reports the session in use and a null result until the human finishes', async () => {
  const { sessionDir, server } = makeWorkspace();

  const before = payloadOf(await call(server, 'vsdiff_status')) as Record<string, unknown>;
  expect(before).toEqual({
    sessionDir,
    title: 'Payments refactor',
    source: { type: 'working-tree' },
    result: null,
  });

  writeFileSync(
    join(sessionDir, 'result.json'),
    JSON.stringify({
      status: 'approved',
      verdicts: { accepted: 3, needsWork: 0, questions: 1 },
      openThreads: [],
      finishedAt: '2026-08-19T10:30:00Z',
    }),
  );
  const after = payloadOf(await call(server, 'vsdiff_status')) as { result: { status: string } };
  expect(after.result.status).toBe('approved');
});

test('vsdiff_await returns the result document the extension wrote', async () => {
  const { sessionDir, server } = makeWorkspace();
  const result = {
    status: 'changes-requested',
    verdicts: { accepted: 1, needsWork: 2, questions: 0 },
    openThreads: ['t1'],
    finishedAt: '2026-08-19T11:00:00Z',
  };

  const pending = call(server, 'vsdiff_await', { timeoutSec: 5 });
  setTimeout(() => {
    writeFileSync(join(sessionDir, 'result.json'), JSON.stringify(result));
  }, 60);

  expect(payloadOf(await pending)).toEqual(result);
});

test('a git-backed workspace scaffolds and inventories the same diff through both tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-mcp-repo-'));
  tempRoots.push(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'absent-global'),
    GIT_CONFIG_SYSTEM: join(root, 'absent-system'),
    GIT_AUTHOR_NAME: 'Fixture Bot',
    GIT_AUTHOR_EMAIL: 'fixture@vsdiff.invalid',
    GIT_COMMITTER_NAME: 'Fixture Bot',
    GIT_COMMITTER_EMAIL: 'fixture@vsdiff.invalid',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-b', 'main');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'first');
  writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');

  const server = makeServer(root);
  const stat = payloadOf(await call(server, 'vsdiff_diffstat')) as Record<string, unknown>;
  expect(stat).toEqual({
    source: { type: 'working-tree' },
    diffstat: { files: 1, hunks: 1, additions: 1, deletions: 1 },
    files: [{ path: 'a.ts', status: 'modified', binary: false, hunks: 1, hunkIds: ['a.ts:h1'] }],
  });

  const scaffolded = payloadOf(await call(server, 'vsdiff_new', { title: 'Bump a' })) as {
    sessionPath: string;
  } & typeof stat;
  expect(scaffolded.sessionPath).toMatch(
    /\.vsdiff\/sessions\/\d{4}-\d{2}-\d{2}-bump-a\/session\.json$/,
  );
  const { sessionPath, ...rest } = scaffolded;
  expect(rest).toEqual(stat);

  // The scaffold is a valid (empty) session, and status now finds it.
  const validated = payloadOf(await call(server, 'vsdiff_validate', { file: sessionPath })) as {
    ok: boolean;
  };
  expect(validated.ok).toBe(true);
  expect(payloadOf(await call(server, 'vsdiff_status'))).toMatchObject({ title: 'Bump a' });
});

// ------------------------------------------------------------ failure modes

test('a workspace with no session answers with an isError result that says what to do', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-mcp-empty-'));
  tempRoots.push(root);

  const result = await call(makeServer(root), 'vsdiff_feedback');

  expect(result.isError).toBe(true);
  expect(result.text).toContain('no session found');
  expect(result.text).toContain('"session"');
});

test('bad and unknown tool arguments come back as isError, never as a crash', async () => {
  const { sessionDir, server } = makeWorkspace();

  const unknownTool = await call(server, 'vsdiff_teleport');
  expect(unknownTool.isError).toBe(true);
  expect(unknownTool.text).toContain('unknown tool "vsdiff_teleport"');
  expect(unknownTool.text).toContain('vsdiff_guide');

  const missingArg = await call(server, 'vsdiff_reply', { thread: 't1' });
  expect(missingArg.isError).toBe(true);
  expect(missingArg.text).toContain('missing required argument "body"');

  const wrongType = await call(server, 'vsdiff_comment', {
    path: 'a.ts',
    line: 'top',
    body: 'hi',
    session: sessionDir,
  });
  expect(wrongType.isError).toBe(true);
  expect(wrongType.text).toContain('"line" must be an integer');

  const strayArg = await call(server, 'vsdiff_status', { sessionDir });
  expect(strayArg.isError).toBe(true);
  expect(strayArg.text).toContain('unknown argument "sessionDir"');

  const badEnum = await call(server, 'vsdiff_diffstat', { type: 'everything' });
  expect(badEnum.isError).toBe(true);
  expect(badEnum.text).toContain('"working-tree"');

  // The server is still healthy after all of that.
  expect((await rpc(server, { jsonrpc: '2.0', id: 99, method: 'ping' }))?.result).toEqual({});
});

test('protocol errors use JSON-RPC codes: parse, invalid request, unknown method', async () => {
  const { server } = makeWorkspace();

  const parseError = JSON.parse((await server.handleLine('{oops')) ?? '') as RpcResponse;
  expect(parseError.id).toBe(null);
  expect(parseError.error?.code).toBe(-32700);

  const notAnObject = JSON.parse((await server.handleLine('[1,2]')) ?? '') as RpcResponse;
  expect(notAnObject.error?.code).toBe(-32600);

  const noMethod = await rpc(server, { jsonrpc: '2.0', id: 4 });
  expect(noMethod?.error?.code).toBe(-32600);
  expect(noMethod?.id).toBe(4);

  const wrongVersion = await rpc(server, { jsonrpc: '1.0', id: 5, method: 'ping' });
  expect(wrongVersion?.error?.code).toBe(-32600);

  const unknownMethod = await rpc(server, { jsonrpc: '2.0', id: 6, method: 'resources/list' });
  expect(unknownMethod?.error?.code).toBe(-32601);
  expect(unknownMethod?.error?.message).toContain('tools/call');
});

test('requests are processed one at a time, in arrival order', async () => {
  const order: string[] = [];
  const tool = (name: string, delayMs: number): McpTool => ({
    name,
    description: `fixture ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(name);
      return { kind: 'json', value: { name } };
    },
  });
  const server = createMcpServer({ tools: [tool('slow', 40), tool('fast', 0)], log: () => {} });

  const first = call(server, 'slow', {}, 1);
  const second = call(server, 'fast', {}, 2);
  const [slow, fast] = await Promise.all([first, second]);

  expect(order).toEqual(['slow', 'fast']);
  expect(payloadOf(slow)).toEqual({ name: 'slow' });
  expect(payloadOf(fast)).toEqual({ name: 'fast' });
});

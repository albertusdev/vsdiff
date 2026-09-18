// `vsdiff mcp` — the review verbs as an MCP server over stdio (blueprint §7.3),
// hand-rolled: newline-delimited JSON-RPC 2.0, one message per line, no SDK.
//
// Three invariants this file exists to keep:
//   1. stdout carries nothing but JSON-RPC, one message per line — every log,
//      note and diagnostic goes to stderr, or the client's parser desyncs;
//   2. a request never kills the server: tool failures come back as `isError`
//      results, protocol failures as JSON-RPC errors;
//   3. requests are processed one at a time in arrival order, so a client that
//      pipelines can still read the replies in the order it sent them.

import { once } from 'node:events';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { checkArgs, createTools, ToolError, type McpTool } from './tools.ts';

/** Echoed back when the client asks for nothing in particular. */
export const PROTOCOL_VERSION = '2025-03-26';

/** Kept in step with main.ts's VERSION by hand — the CLI entry is a script, not a module. */
export const SERVER_INFO = { name: 'vsdiff', version: '0.0.1' } as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface McpServerOptions {
  /** Working directory tools resolve sessions and paths against. */
  cwd?: string;
  /** Overridable so tests can drive the protocol with fixture tools. */
  tools?: readonly McpTool[];
  /** Diagnostics sink; defaults to stderr. */
  log?: (message: string) => void;
}

export interface McpServer {
  /** One line in, one line of JSON-RPC out — or null for a notification. */
  handleLine(line: string): Promise<string | null>;
  readonly tools: readonly McpTool[];
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

type RequestId = string | number | null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function resultLine(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorLine(id: RequestId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const tools = options.tools ?? createTools({ cwd });
  const log =
    options.log ?? ((message: string) => process.stderr.write(`vsdiff mcp: ${message}\n`));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  function initialize(params: unknown): unknown {
    const requested = isRecord(params) ? params['protocolVersion'] : undefined;
    return {
      protocolVersion:
        typeof requested === 'string' && requested.length > 0 ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }

  async function callTool(params: unknown): Promise<ToolCallResult> {
    const name = isRecord(params) ? params['name'] : undefined;
    if (typeof name !== 'string') {
      return errorResult(
        'tools/call needs params {"name": "<tool>", "arguments": {…}} — see tools/list for the tools and their schemas.',
      );
    }
    const tool = byName.get(name);
    if (tool === undefined) {
      return errorResult(
        `unknown tool "${name}" — this server offers ${[...byName.keys()].join(', ')}.`,
      );
    }
    try {
      const args = checkArgs(tool, isRecord(params) ? params['arguments'] : undefined);
      const output = await tool.run(args);
      const text =
        output.kind === 'text' ? output.text : `${JSON.stringify(output.value, null, 2)}`;
      return { content: [{ type: 'text', text }], isError: false };
    } catch (error) {
      const message =
        error instanceof ToolError
          ? error.message
          : `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
      log(`tool ${name}: ${message.split('\n')[0]}`);
      return errorResult(message);
    }
  }

  async function route(id: RequestId, method: string, params: unknown): Promise<string> {
    switch (method) {
      case 'initialize':
        return resultLine(id, initialize(params));
      case 'ping':
        return resultLine(id, {});
      case 'tools/list':
        return resultLine(id, {
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case 'tools/call':
        return resultLine(id, await callTool(params));
      default:
        return errorLine(
          id,
          METHOD_NOT_FOUND,
          `unknown method "${method}" — this server implements initialize, ping, tools/list and tools/call.`,
        );
    }
  }

  async function dispatch(line: string): Promise<string | null> {
    if (line.trim().length === 0) return null;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      return errorLine(null, PARSE_ERROR, `parse error: ${(error as Error).message}`);
    }
    if (!isRecord(message)) {
      return errorLine(
        null,
        INVALID_REQUEST,
        'invalid request: send one JSON-RPC object per line (batches are not supported).',
      );
    }

    const rawId = message['id'];
    const isNotification = rawId === undefined;
    if (
      !isNotification &&
      typeof rawId !== 'string' &&
      typeof rawId !== 'number' &&
      rawId !== null
    ) {
      return errorLine(
        null,
        INVALID_REQUEST,
        'invalid request: "id" must be a string, number or null.',
      );
    }
    const id = (isNotification ? null : rawId) as RequestId;

    const method = message['method'];
    if (typeof method !== 'string') {
      return errorLine(id, INVALID_REQUEST, 'invalid request: "method" must be a string.');
    }
    if (message['jsonrpc'] !== '2.0') {
      return errorLine(id, INVALID_REQUEST, 'invalid request: "jsonrpc" must be "2.0".');
    }
    // Notifications (notifications/initialized, notifications/cancelled, …) are
    // acknowledged by saying nothing at all — a response would desync the client.
    if (isNotification) return null;

    try {
      return await route(id, method, message['params']);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`internal error handling ${method}: ${detail}`);
      return errorLine(id, INTERNAL_ERROR, `internal error: ${detail}`);
    }
  }

  // One line at a time, in arrival order: each call is chained onto the last, so
  // a client that pipelines requests reads its replies in the order it sent them.
  let queue: Promise<unknown> = Promise.resolve();

  function handleLine(line: string): Promise<string | null> {
    // The catch is a backstop: `dispatch` answers its own failures, but a bug in
    // it must still produce a line rather than take the process down.
    const run = queue
      .then(() => dispatch(line))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log(`internal error: ${detail}`);
        return errorLine(null, INTERNAL_ERROR, `internal error: ${detail}`);
      });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { handleLine, tools };
}

/**
 * The stdio pump: stdin lines in, response lines out, nothing else on stdout.
 * Ends (exit 0) when the client closes stdin.
 */
export async function runMcpStdio(options: McpServerOptions = {}): Promise<number> {
  const server = createMcpServer(options);
  const log =
    options.log ?? ((message: string) => process.stderr.write(`vsdiff mcp: ${message}\n`));
  const write = (line: string): void => void process.stdout.write(`${line}\n`);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending: Promise<void> = Promise.resolve();
  input.on('line', (line: string) => {
    pending = pending.then(async () => {
      const response = await server.handleLine(line);
      if (response !== null) write(response);
    });
    pending = pending.catch((error: unknown) => {
      log(`dropped a line: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  log(`serving ${server.tools.length} tools on stdio (cwd ${options.cwd ?? process.cwd()})`);
  await once(input, 'close');
  await pending;
  return 0;
}

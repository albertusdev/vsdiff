import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY = 1024 * 1024;

/** Local test control is privileged: require a per-process secret even on loopback. */
export function createBridgeServer(
  getState: () => unknown,
  execute: (command: string, ...args: unknown[]) => unknown | PromiseLike<unknown>,
) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host;
    const port = req.socket.localPort;
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (
      req.headers.origin !== undefined ||
      (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      respond(403, { ok: false, error: 'forbidden' });
      return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      respond(200, { ok: true, state: getState() });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/exec') {
      respond(404, { ok: false, error: 'unknown endpoint' });
      return;
    }
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      respond(415, { ok: false, error: 'application/json required' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!res.writableEnded) respond(413, { ok: false, error: 'request too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      void (async () => {
        try {
          const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new Error('invalid request');
          const { command, args = [] } = input as { command?: unknown; args?: unknown };
          if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)) {
            throw new Error('expected a command string and an args array');
          }
          const result = await execute(command, ...args);
          respond(200, { ok: true, result: result ?? null });
        } catch (error) {
          respond(400, { ok: false, error: String(error) });
        }
      })();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return { server, token };
}

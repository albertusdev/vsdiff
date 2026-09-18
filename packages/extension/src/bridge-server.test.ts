import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createBridgeServer } from './bridge-server.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const calls: string[] = [];
  const { server, token } = createBridgeServer(
    () => ({ sentinel: 'private-state' }),
    (command) => {
      calls.push(command);
      return 'executed';
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

test('rejects anonymous, forged origin/host, and wrong-token requests before executing', async () => {
  const f = await fixture();
  for (const headers of [
    {},
    { ...f.headers, Authorization: 'Bearer wrong' },
    { ...f.headers, Origin: 'https://attacker.example' },
  ]) {
    const r = await fetch(`${f.url}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'dangerous.command' }),
    });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('private-state');
  }
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${f.url}/exec`,
      { method: 'POST', headers: { ...f.headers, Host: 'attacker.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ command: 'dangerous.command' }));
  });
  expect(forgedHost).toBe(403);
  expect((await fetch(`${f.url}/state`)).status).toBe(403);
  expect(f.calls).toEqual([]);
  const good = await fetch(`${f.url}/exec`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ command: 'allowed.command', args: [] }),
  });
  expect(good.status).toBe(200);
  expect(f.calls).toEqual(['allowed.command']);
  expect((await fetch(`${f.url}/state`, { headers: f.headers })).status).toBe(200);
});

test('rejects simple form posts, malformed requests, and oversized bodies', async () => {
  const f = await fixture();
  const send = (body: string, headers = f.headers) =>
    fetch(`${f.url}/exec`, { method: 'POST', headers, body });
  expect((await send('{}', { ...f.headers, 'Content-Type': 'text/plain' })).status).toBe(415);
  expect((await send('{')).status).toBe(400);
  expect((await send(JSON.stringify({ command: 42, args: {} }))).status).toBe(400);
  expect((await send('x'.repeat(1024 * 1024 + 1))).status).toBe(413);
  expect(f.calls).toEqual([]);
});

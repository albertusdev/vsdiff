import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDiff } from '../packages/core/dist/index.mjs';
import { validateSession } from '../packages/schema/dist/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const before = {
  'src/payments.ts': `import { charge } from './gateway';
import { retry } from './retry';

export interface Payment {
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export async function capturePayment(payment: Payment) {
  return retry(() => charge({
    amount: payment.amount,
    currency: payment.currency,
  }));
}
`,
  'src/retry.ts': `export async function retry<T>(work: () => Promise<T>): Promise<T> {
  return work();
}
`,
  'src/gateway.ts': `export class GatewayError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

export async function charge(request: {
  amount: number;
  currency: string;
  idempotencyKey?: string;
}) {
  // The real gateway deduplicates requests by idempotencyKey.
  return { id: 'payment_123', amount: request.amount };
}
`,
};
const after = {
  'src/payments.ts': `import { charge } from './gateway';
import { retry } from './retry';

export interface Payment {
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export async function capturePayment(payment: Payment) {
  if (payment.amount <= 0 || !payment.idempotencyKey.trim()) {
    throw new Error('A positive amount and payment key are required.');
  }

  // Reuse the same key on every attempt, including after a timeout.
  const request = {
    amount: payment.amount,
    currency: payment.currency,
    idempotencyKey: payment.idempotencyKey,
  };
  return retry(() => charge(request));
}
`,
  'src/retry.ts': `import { GatewayError } from './gateway';

export async function retry<T>(work: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const temporary = error instanceof GatewayError && error.retryable;
      if (!temporary || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
`,
  'tests/payments.test.ts': `import { expect, test, vi } from 'vitest';
import { capturePayment } from '../src/payments';
import { charge, GatewayError } from '../src/gateway';

vi.mock('../src/gateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/gateway')>(),
  charge: vi.fn(),
}));

test('a timeout retries with the original payment key', async () => {
  vi.mocked(charge)
    .mockRejectedValueOnce(new GatewayError('timeout', true))
    .mockResolvedValueOnce({ id: 'payment_123', amount: 2500 });

  await capturePayment({
    amount: 2500,
    currency: 'USD',
    idempotencyKey: 'checkout-42',
  });

  expect(charge).toHaveBeenCalledTimes(2);
  expect(vi.mocked(charge).mock.calls.map(([request]) => request.idempotencyKey))
    .toEqual(['checkout-42', 'checkout-42']);
});
`,
};

export async function createDemo() {
  const parent = join(ROOT, '.dev', 'demo');
  mkdirSync(parent, { recursive: true });
  const folder = join(mkdtempSync(join(parent, 'run-')), 'payments-review');
  mkdirSync(folder);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'vsdiff demo',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'vsdiff demo',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: folder,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (path, body) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), body);
  };
  git('init', '-b', 'main');
  for (const [path, body] of Object.entries(before)) write(path, body);
  git('add', '.');
  git('commit', '-m', 'Original payment flow');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'retry-payments');
  for (const [path, body] of Object.entries(after)) write(path, body);
  git('add', '.');
  git('commit', '-m', 'Retry temporary failures with a stable payment key');
  const head = git('rev-parse', 'HEAD');
  const diff = await computeDiff(folder, { type: 'range', base, head });
  const hunks = (path) =>
    diff.files.find((file) => file.path === path).hunks.map((_, i) => `${path}:h${i + 1}`);
  const session = {
    version: 1,
    kind: 'review',
    title: 'Retry payments safely',
    focus: 'A timeout should retry the request without charging the customer twice.',
    source: { type: 'range', base, head },
    chapters: [
      {
        id: 'payments',
        title: 'One payment',
        blurb: 'Follow the key from the API call to the regression test.',
        stops: [
          {
            id: 'payment-key',
            kind: 'walkthrough',
            title: 'Keep the payment key',
            prose:
              'The request is built once, before retrying. Every attempt keeps the same idempotency key, so the gateway can recognise a payment it already accepted.\n\nCheck that callers generate the key before entering this function. If a caller creates a new key after a timeout, the gateway will see a second payment. The validation here rejects a missing key and a non-positive amount; it does not choose a key for the caller.',
            hunkIds: hunks('src/payments.ts'),
          },
          {
            id: 'retry-budget',
            kind: 'question',
            title: 'Retry temporary errors',
            prose:
              'Only errors marked retryable get another attempt, up to three attempts total. Is this delay long enough for the gateway, or should it honour a Retry-After response?',
            hunkIds: hunks('src/retry.ts'),
          },
          {
            id: 'regression',
            kind: 'verify',
            title: 'Test the retry',
            prose:
              'The gateway times out once, then succeeds. Both calls must carry checkout-42. Run this test while reviewing changes to the retry loop.',
            hunkIds: hunks('tests/payments.test.ts'),
          },
        ],
      },
    ],
  };
  const validated = validateSession(session);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const sessionDir = join(folder, '.vsdiff/sessions/retry-payments');
  write('.vsdiff/sessions/retry-payments/session.json', JSON.stringify(session, null, 2) + '\n');
  write(
    '.vscode/settings.json',
    JSON.stringify(
      {
        'editor.fontSize': 14,
        'editor.wordWrap': 'on',
        'diffEditor.diffWordWrap': 'on',
        'editor.minimap.enabled': false,
        'breadcrumbs.enabled': false,
        'workbench.colorTheme': 'Default Dark Modern',
        'window.commandCenter': false,
      },
      null,
      2,
    ),
  );
  return { folder, sessionDir };
}

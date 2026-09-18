#!/usr/bin/env node
// Deterministic fixture repos for tests and demos (blueprint §5).
// S — a small TS repo with a base commit and working-tree changes.
// L — ~120 files / ~12k changed LOC across a two-commit range, the standing
// answer to "does this survive a 10k-LOC PR?" and the subject of the R9 budgets.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyBlock,
  blockOffset,
  changeBlock,
  contentLines,
  fakePngBytes,
  hash32,
  lineTargetFor,
  lockLines,
  MIN_LINES,
} from './fixture-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, '.dev', 'fixtures');
const S_REPO = join(FIXTURES, 's-repo');
const L_REPO = join(FIXTURES, 'l-repo');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture Bot',
  GIT_AUTHOR_EMAIL: 'fixture@vsdiff.invalid',
  GIT_COMMITTER_NAME: 'Fixture Bot',
  GIT_COMMITTER_EMAIL: 'fixture@vsdiff.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function runGit(cwd, env, args) {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function git(cwd, ...args) {
  return runGit(cwd, GIT_ENV, args);
}

/** Same as git(), with the author/committer dates pinned to `date`. */
function gitAt(cwd, date, ...args) {
  return runGit(cwd, { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, args);
}

function write(repo, path, content) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

rmSync(S_REPO, { recursive: true, force: true });
mkdirSync(S_REPO, { recursive: true });
git(S_REPO, 'init', '-b', 'main');

write(
  S_REPO,
  'src/greeter.ts',
  `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
);
write(
  S_REPO,
  'src/math.ts',
  `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`,
);
write(S_REPO, 'README.md', `# s-repo\n\nDeterministic small fixture for vsdiff tests.\n`);
git(S_REPO, 'add', '.');
git(S_REPO, 'commit', '-m', 'base');

// Working-tree changes: one modified file, one new file.
write(
  S_REPO,
  'src/greeter.ts',
  `export function greet(name: string): string {\n  return \`Hello, \${name.trim()}!\`;\n}\n\nexport function farewell(name: string): string {\n  return \`Goodbye, \${name.trim()}.\`;\n}\n`,
);
write(
  S_REPO,
  'src/clock.ts',
  `export function now(): string {\n  return new Date().toISOString();\n}\n`,
);

console.log(`[fixture] S fixture ready at ${S_REPO}`);

// ---------------------------------------------------------------- L fixture

const HEAD_DATE = '2026-01-02T00:00:00Z';
// Tuned so additions+deletions land near the R9 target of ~12k changed LOC:
// the lockfile is rewritten line-for-line, so it contributes 2x this number.
const LOCK_LINE_COUNT = 5600;

const under = (dir, names) => names.map((name) => `${dir}/${name}`);

const AUTH = under('src/auth', [
  'token.ts',
  'validate.ts',
  'session.ts',
  'password.ts',
  'oauth.ts',
  'mfa.ts',
  'scopes.ts',
  'device.ts',
  'jwt.ts',
  'keys.ts',
  'cookies.ts',
  'audit.ts',
]);
const PAYMENTS = under('src/payments', [
  'capture.ts',
  'refund.ts',
  'charge.ts',
  'ledger.ts',
  'idempotency.ts',
  'gateway.ts',
  'currency.ts',
  'fees.ts',
  'payouts.ts',
  'disputes.ts',
  'invoice.ts',
  'methods.ts',
  'receipts.ts',
  'retry.ts',
  'settlement.ts',
]);
const API = under('src/api', [
  'client.ts',
  'routes.ts',
  'handlers.ts',
  'middleware.ts',
  'errors.ts',
  'schema.ts',
  'pagination.ts',
  'ratelimit.ts',
  'serialize.ts',
  'headers.ts',
  'health.ts',
  'version.ts',
]);
const UI = under('src/ui', [
  'button.ts',
  'card.ts',
  'modal.ts',
  'table.ts',
  'form.ts',
  'input.ts',
  'select.ts',
  'toast.ts',
  'tabs.ts',
  'tooltip.ts',
  'badge.ts',
  'avatar.ts',
  'drawer.ts',
  'menu.ts',
  'pagination.ts',
  'spinner.ts',
  'stepper.ts',
  'banner.ts',
  'chart.ts',
  'legend.ts',
  'tree.ts',
  'grid.ts',
  'list.ts',
  'panel.ts',
  'dialog.ts',
]);
const UTIL = under('src/util', [
  'strings.ts',
  'arrays.ts',
  'dates.ts',
  'numbers.ts',
  'objects.ts',
  'promise.ts',
  'result.ts',
  'logger.ts',
  'assert.ts',
  'clone.ts',
  'env.ts',
  'hash.ts',
  'id.ts',
  'path.ts',
  'sleep.ts',
  'uuid.ts',
]);
const TESTS = under(
  'tests',
  [
    'auth-token',
    'auth-validate',
    'auth-session',
    'auth-oauth',
    'auth-jwt',
    'payments-capture',
    'payments-refund',
    'payments-charge',
    'payments-ledger',
    'payments-idempotency',
    'payments-gateway',
    'payments-retry',
    'api-client',
    'api-routes',
    'api-handlers',
    'api-middleware',
    'api-errors',
    'ui-button',
    'ui-modal',
    'ui-table',
    'ui-form',
    'util-strings',
    'util-arrays',
    'util-result',
    'util-hash',
  ].map((name) => `${name}.test.ts`),
);
const DOCS = under('docs', [
  'payments.md',
  'auth.md',
  'api.md',
  'ui.md',
  'architecture.md',
  'getting-started.md',
  'testing.md',
  'deployment.md',
  'faq.md',
  'changelog.md',
]);

const BASE_SOURCES = [...AUTH, ...PAYMENTS, ...API, ...UI, ...UTIL, ...TESTS, ...DOCS];

// Files that get two separated change blocks: long enough that unified=3
// context can never bridge the gap, so each yields exactly two hunks.
const TWO_HUNK = ['src/payments/capture.ts', 'src/payments/refund.ts', 'src/api/client.ts'];
const TWO_HUNK_MIN_LINES = 90;

const ONE_HUNK = [
  'src/auth/validate.ts',
  'src/auth/session.ts',
  'src/auth/oauth.ts',
  'src/auth/jwt.ts',
  'src/auth/scopes.ts',
  'src/payments/charge.ts',
  'src/payments/ledger.ts',
  'src/payments/idempotency.ts',
  'src/payments/gateway.ts',
  'src/payments/retry.ts',
  'src/payments/fees.ts',
  'src/payments/disputes.ts',
  'src/payments/settlement.ts',
  'src/api/routes.ts',
  'src/api/handlers.ts',
  'src/api/middleware.ts',
  'src/api/errors.ts',
  'src/api/ratelimit.ts',
  'src/api/headers.ts',
  'src/ui/button.ts',
  'src/ui/modal.ts',
  'src/ui/table.ts',
  'src/ui/form.ts',
  'src/ui/toast.ts',
  'src/ui/dialog.ts',
  'src/util/arrays.ts',
  'src/util/result.ts',
  'src/util/logger.ts',
  'src/util/hash.ts',
  'src/util/id.ts',
  'tests/payments-capture.test.ts',
  'tests/payments-refund.test.ts',
  'tests/api-client.test.ts',
  'tests/auth-token.test.ts',
  'tests/auth-validate.test.ts',
  'tests/util-strings.test.ts',
  'docs/payments.md',
  'docs/api.md',
];

const NEW_FILES = [
  'src/api/webhooks.ts',
  'src/payments/capture-context.ts',
  'src/payments/retry-budget.ts',
  'tests/api-webhooks.test.ts',
  'docs/webhooks.md',
];

const DELETED = ['src/ui/stepper.ts', 'src/ui/banner.ts', 'src/ui/legend.ts'];

/** Generated blocks end in a blank line; files should not. */
const joinLines = (lines) => `${(lines.at(-1) === '' ? lines.slice(0, -1) : lines).join('\n')}\n`;

rmSync(L_REPO, { recursive: true, force: true });
mkdirSync(L_REPO, { recursive: true });
git(L_REPO, 'init', '-b', 'main');

const baseLines = new Map(
  BASE_SOURCES.map((path) => [
    path,
    contentLines(
      path,
      TWO_HUNK.includes(path) ? Math.max(TWO_HUNK_MIN_LINES, lineTargetFor(path)) : undefined,
    ),
  ]),
);
for (const [path, lines] of baseLines) {
  write(L_REPO, path, joinLines(lines));
}

write(
  L_REPO,
  'package.json',
  `${JSON.stringify(
    {
      name: 'l-repo',
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run' },
    },
    null,
    2,
  )}\n`,
);
write(
  L_REPO,
  'tsconfig.json',
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['src', 'tests'],
    },
    null,
    2,
  )}\n`,
);
write(L_REPO, 'vendor/generated.lock.txt', joinLines(lockLines(LOCK_LINE_COUNT, 1)));
write(L_REPO, 'assets/logo.png', fakePngBytes(1));

git(L_REPO, 'add', '-A');
git(L_REPO, 'commit', '-m', 'base: payments platform snapshot');
git(L_REPO, 'checkout', '-b', 'feature/payments-refactor');

// 1. Two separated change blocks — two hunks each.
for (const path of TWO_HUNK) {
  const lines = baseLines.get(path);
  const [first, second] = [blockOffset(path, lines, 0.2), blockOffset(path, lines, 0.65)];
  // Later block first, so `first` stays a valid offset into the array.
  let edited = applyBlock(lines, second, changeBlock(path, 'Rework2'));
  edited = applyBlock(edited, first, changeBlock(path, 'Rework1'));
  write(L_REPO, path, joinLines(edited));
}

// 2. One contiguous change block each — one hunk.
for (const path of ONE_HUNK) {
  const lines = baseLines.get(path);
  const fraction = 0.2 + (hash32(`${path}:where`) % 60) / 100;
  const at = blockOffset(path, lines, fraction);
  write(L_REPO, path, joinLines(applyBlock(lines, at, changeBlock(path, 'Rework'))));
}

// 3. New files.
for (const path of NEW_FILES) {
  write(L_REPO, path, joinLines(contentLines(path, MIN_LINES)));
}

// 4. Deletions.
for (const path of DELETED) {
  rmSync(join(L_REPO, path));
}

// 5. Pure rename — content byte-identical, so git reports 100% similarity.
rmSync(join(L_REPO, 'src/util/strings.ts'));
write(L_REPO, 'src/util/text.ts', joinLines(baseLines.get('src/util/strings.ts')));

// 6. Rename + one change block.
{
  const tokensPath = 'src/auth/tokens.ts';
  const lines = baseLines.get('src/auth/token.ts');
  const at = blockOffset(tokensPath, lines, 0.4);
  rmSync(join(L_REPO, 'src/auth/token.ts'));
  write(L_REPO, tokensPath, joinLines(applyBlock(lines, at, changeBlock(tokensPath, 'Rework'))));
}

// 7. Binary change.
write(L_REPO, 'assets/logo.png', fakePngBytes(2));

// 8. Regenerated lockfile — every line differs, so one giant hunk.
write(L_REPO, 'vendor/generated.lock.txt', joinLines(lockLines(LOCK_LINE_COUNT, 2)));

git(L_REPO, 'add', '-A');
gitAt(L_REPO, HEAD_DATE, 'commit', '-m', 'payments: rework capture pipeline and retry budget');

// Golden session for the range — the demo/perf subject for R9.
const SESSION = {
  version: 1,
  kind: 'review',
  title: 'Payments refactor',
  focus: 'Capture pipeline rework; retries and refund symmetry deserve the closest look.',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  guide: { html: 'guide/index.html' },
  chapters: [
    {
      id: 'capture',
      title: 'Capture',
      blurb: 'Where the money moves.',
      stops: [
        {
          id: 'pipeline',
          kind: 'walkthrough',
          title: 'New capture pipeline',
          prose:
            'Read this before the handlers; everything downstream assumes the new `CaptureContext` shape.',
          hunkIds: ['src/payments/capture.ts:h1'],
        },
        {
          id: 'retry-guard',
          kind: 'finding',
          severity: 'major',
          title: 'Double-charge guard lost on retry',
          prose:
            'The retry path re-enters `capture` without re-checking `idempotencyKey`; both callers can charge twice under a timeout.',
          hunkIds: ['src/payments/capture.ts:h2', 'src/api/client.ts:h1'],
        },
        {
          id: 'refund-mirror',
          kind: 'verify',
          title: 'Refund path mirrors capture',
          prose:
            'Confirm the refund flow applies the same context and guard changes as capture — the two must stay symmetric.',
          hunkIds: ['src/payments/refund.ts:h1', 'src/payments/refund.ts:h2'],
        },
      ],
    },
    {
      id: 'auth',
      title: 'Auth',
      blurb: 'Rename plus one open question.',
      stops: [
        {
          id: 'token-rename',
          kind: 'walkthrough',
          title: 'Token module rename',
          prose:
            '`token.ts` becomes `tokens.ts` with the loader signature widened; call sites were updated mechanically.',
          hunkIds: ['src/auth/tokens.ts:h1'],
        },
        {
          id: 'legacy-validator',
          kind: 'question',
          title: 'Why keep the legacy validator?',
          prose:
            '`validate.ts` still exports the pre-refactor entry point — is that deliberate compatibility or leftover?',
          hunkIds: ['src/auth/validate.ts:h1'],
        },
      ],
    },
    {
      id: 'api',
      title: 'API',
      blurb: 'Client budget and new surface.',
      stops: [
        {
          id: 'retry-budget',
          kind: 'walkthrough',
          title: 'Client retry budget',
          prose:
            'Retries now share one budget per request instead of per attempt; watch the interaction with the capture guard above.',
          hunkIds: ['src/api/client.ts:h2'],
        },
        {
          id: 'docs-drift',
          kind: 'finding',
          severity: 'minor',
          title: 'Docs lag the new flow',
          prose:
            '`docs/payments.md` still documents the old two-phase capture; fine to fix in a follow-up but flagging it.',
          hunkIds: ['docs/payments.md:h1'],
        },
        {
          id: 'webhooks',
          kind: 'walkthrough',
          title: 'New webhook surface',
          prose: 'Brand-new file; skim the shape — the handlers are stubs wired in a later change.',
          hunkIds: ['src/api/webhooks.ts:h1'],
        },
      ],
    },
  ],
  support: [{ id: 'lockfile', reason: 'generated', hunkIds: ['vendor/generated.lock.txt:h1'] }],
};

write(
  L_REPO,
  '.vsdiff/sessions/2026-01-02-payments-refactor/session.json',
  JSON.stringify(SESSION, null, 2),
);
write(
  L_REPO,
  '.vsdiff/sessions/2026-01-02-payments-refactor/guide/index.html',
  `<!doctype html>
<title>Payments refactor — review guide</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); max-width: 46rem; margin: 0 auto;
         padding: 1.5rem 1rem 3rem; line-height: 1.55; }
  h1 { font-size: 1.35rem; } h2 { font-size: 1.05rem; margin-top: 1.6rem; }
  a { color: var(--vscode-textLink-foreground); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px;
          padding: .7rem .9rem; margin: .5rem 0; }
  .sev { font-weight: 600; color: var(--vscode-errorForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 0; border-radius: 4px; padding: .35rem .7rem; cursor: pointer; }
  #pos { opacity: .75; font-size: .85rem; }
</style>
<h1>How to review this refactor</h1>
<p>The money path changed shape: capture now runs through a shared context, and the
retry budget moved from per-attempt to per-request. Read it in this order, not file order.</p>
<h2>1 · The one that can double-charge</h2>
<div class="card"><span class="sev">major</span> — start at
  <a href="vsdiff://stop/retry-guard">the retry guard finding</a>: two callers can both
  pass the idempotency check before either records the charge.</div>
<h2>2 · Then the shape underneath</h2>
<div class="card"><a href="vsdiff://stop/pipeline">The new capture pipeline</a> explains
  the <code>CaptureContext</code> everything else assumes; verify
  <a href="vsdiff://stop/refund-mirror">refund symmetry</a> right after.</div>
<h2>3 · Everything else</h2>
<p>Auth is a mechanical rename plus one open question; API adds a webhook surface.
  <button onclick="window.vsdiff.nextStop()">Next stop ›</button></p>
<p id="pos"></p>
<script>
  const render = () => {
    const s = window.vsdiff.state;
    if (s) document.getElementById('pos').textContent =
      'You are at stop ' + (s.currentIndex + 1) + '/' + s.stops.length +
      ' — ' + (s.stops[s.currentIndex]?.title ?? '');
  };
  render();
  window.addEventListener('vsdiff:state', render);
</script>
`,
);

console.log(`[fixture] L fixture ready at ${L_REPO}`);

// ------------------------------------------------------------- L self-check
// The fixture is only useful if its shape is exactly what the golden session
// claims, so the generator proves it every run instead of trusting the recipe.

const EXPECTED_HUNKS = {
  'src/payments/capture.ts': 2,
  'src/payments/refund.ts': 2,
  'src/api/client.ts': 2,
  'src/auth/validate.ts': 1,
  'docs/payments.md': 1,
  'src/auth/tokens.ts': 1,
  'src/api/webhooks.ts': 1,
  'vendor/generated.lock.txt': 1,
};
const CHURN_MIN = 9000;
const CHURN_MAX = 15000;

const diff = git(L_REPO, 'diff', 'main...HEAD');
const hunks = new Map();
let current = null;
let removedPath = null;
for (const line of diff.split('\n')) {
  if (line.startsWith('diff --git ')) {
    current = null;
    removedPath = null;
  } else if (line.startsWith('--- a/')) {
    removedPath = line.slice('--- a/'.length);
  } else if (line.startsWith('+++ b/')) {
    current = line.slice('+++ b/'.length);
    if (!hunks.has(current)) hunks.set(current, 0);
  } else if (line === '+++ /dev/null') {
    current = removedPath;
    if (!hunks.has(current)) hunks.set(current, 0);
  } else if (line.startsWith('@@ ') && current !== null) {
    hunks.set(current, hunks.get(current) + 1);
  }
}

const failures = [];
const check = (label, ok, detail) => {
  console.log(`[fixture:L] ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
};

for (const [path, expected] of Object.entries(EXPECTED_HUNKS)) {
  const actual = hunks.get(path) ?? 0;
  check(`hunks ${path}`, actual === expected, `${actual} (expected ${expected})`);
}

// The named files above are the ones the golden session cites; the rest of the
// single-block edits must hold their shape too, or `path:h1` stops resolving.
const multiHunk = ONE_HUNK.filter((path) => (hunks.get(path) ?? 0) !== 1);
check(
  'hunks every single-block file',
  multiHunk.length === 0,
  multiHunk.length === 0
    ? `${ONE_HUNK.length} files with exactly 1 hunk`
    : `not 1 hunk: ${multiHunk.join(', ')}`,
);

const renamed =
  diff.includes('rename from src/util/strings.ts') && diff.includes('rename to src/util/text.ts');
check(
  'rename src/util/strings.ts',
  renamed,
  renamed ? 'detected as a rename' : 'NOT detected as a rename',
);

const shortstat = git(L_REPO, 'diff', '--shortstat', 'main...HEAD').trim();
const [, files = '0', added = '0', deleted = '0'] =
  shortstat.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
  ) ?? [];
const churn = Number(added) + Number(deleted);
check(
  'churn additions+deletions',
  churn >= CHURN_MIN && churn <= CHURN_MAX,
  `${churn} in [${CHURN_MIN}, ${CHURN_MAX}] — ${files} files, +${added} -${deleted}`,
);

if (failures.length > 0) {
  console.error(`[fixture:L] ${failures.length} self-check failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`[fixture:L] all self-checks passed — ${shortstat}`);

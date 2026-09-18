import { expect, test } from 'vitest';
import { STOP_TITLE_MAX, SCHEMA_VERSION, validateSession, type ValidationIssue } from './index.ts';

type Json = Record<string, unknown>;

const stop = (over: Json = {}): Json => ({
  id: 's1',
  prose: 'Read this first.',
  hunkIds: ['src/a.ts:h1'],
  ...over,
});

const chapter = (over: Json = {}): Json => ({
  id: 'c1',
  title: 'Core',
  stops: [stop()],
  ...over,
});

const session = (over: Json = {}): Json => ({
  version: SCHEMA_VERSION,
  kind: 'review',
  title: 'Test session',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  chapters: [chapter()],
  ...over,
});

function issuesOf(doc: unknown): ValidationIssue[] {
  const result = validateSession(doc);
  return result.ok ? [] : result.errors;
}

/** The single issue reported at `path`; fails loudly with the full list otherwise. */
function at(doc: unknown, path: string): ValidationIssue {
  const all = issuesOf(doc);
  const hits = all.filter((issue) => issue.path === path);
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly 1 issue at "${path}", got ${hits.length}. All: ${JSON.stringify(all, null, 2)}`,
    );
  }
  return hits[0] as ValidationIssue;
}

function expectValid(doc: unknown): void {
  const result = validateSession(doc);
  if (!result.ok) {
    throw new Error(`expected valid, got ${JSON.stringify(result.errors, null, 2)}`);
  }
}

// --- happy path -------------------------------------------------------------

test('accepts a full session using every optional field', () => {
  const doc = session({
    focus: 'Token refresh moved into middleware.',
    guide: { html: 'guide/index.html' },
    intent: 'proposal',
    commit: { title: 'auth: move refresh into middleware', body: 'why it moved' },
    pr: { number: 4132, headSha: 'a'.repeat(40) },
    chapters: [
      chapter({
        blurb: 'Where the behavior actually changes.',
        stops: [
          stop({
            id: 'refresh-race',
            kind: 'finding',
            severity: 'major',
            title: 'Concurrent refresh can double-issue tokens',
            hunkIds: ['src/auth/middleware.ts:h2', 'src/auth/session.ts:h1'],
            anchors: [
              {
                path: 'src/api/client.ts',
                side: 'head',
                start: 88,
                end: 96,
                context: 'await refreshToken()',
              },
            ],
            suggestion: { patch: '--- a/src/auth/middleware.ts\n+++ b/src/auth/middleware.ts\n' },
            checks: ['Confirm single-flight behavior under two parallel 401s'],
          }),
          stop({ id: 'mw-shape', kind: 'walkthrough', hunkIds: ['src/auth/middleware.ts:h1'] }),
        ],
      }),
    ],
    support: [
      {
        id: 'lockfile',
        reason: 'generated',
        note: 'no review value',
        hunkIds: ['pnpm-lock.yaml:h1'],
      },
    ],
  });
  expectValid(doc);
});

test('accepts a raw object as well as a JSON string', () => {
  const doc = session();
  expectValid(doc);
  expectValid(JSON.stringify(doc));
});

test('accepts an empty chapters array', () => {
  expectValid(session({ chapters: [] }));
});

test('accepts a stop anchored only by a line range', () => {
  const only = stop({
    hunkIds: undefined,
    anchors: [{ path: 'a.ts', side: 'head', start: 1, end: 1 }],
  });
  delete only['hunkIds'];
  expectValid(session({ chapters: [chapter({ stops: [only] })] }));
});

test('returns the parsed session with unknown fields intact', () => {
  const result = validateSession(JSON.stringify(session({ 'x-agent': { run: 7 } })));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.session['x-agent']).toEqual({ run: 7 });
    expect(result.session.title).toBe('Test session');
  }
});

// --- document level ---------------------------------------------------------

test('rejects malformed JSON with a readable, actionable error', () => {
  const issue = at('{nope', '$');
  expect(issue.message).toMatch(/not valid JSON/);
  expect(issue.hint).toMatch(/one plain JSON object/);
});

test('rejects a document that is not an object', () => {
  expect(at([], '$').message).toMatch(/must be a JSON object \(got array\)/);
});

test('rejects a wrong version', () => {
  const issue = at(session({ version: 2 }), 'version');
  expect(issue.message).toMatch(/must be the number 1 \(got number\)/);
  expect(issue.hint).toMatch(/"version": 1/);
});

test('rejects a wrong kind', () => {
  expect(at(session({ kind: 'walkthrough' }), 'kind').message).toMatch(/"kind" must be "review"/);
});

test('rejects an empty title', () => {
  expect(at(session({ title: '' }), 'title').message).toMatch(/non-empty string/);
});

test('rejects a non-string focus', () => {
  expect(at(session({ focus: 12 }), 'focus').message).toMatch(/must be a string when present/);
});

test('rejects a missing source', () => {
  const doc = session();
  delete doc['source'];
  expect(at(doc, 'source').message).toMatch(/naming the diff this session anchors against/);
});

test('rejects an unknown source type', () => {
  const issue = at(session({ source: { type: 'branch' } }), 'source.type');
  expect(issue.message).toMatch(/"working-tree", "staged", "commit", "range" \(got "branch"\)/);
});

test('rejects a non-string source ref', () => {
  expect(
    at(session({ source: { type: 'range', base: 1, head: 'HEAD' } }), 'source.base').message,
  ).toMatch(/must be a non-empty string \(got number\)/);
});

test('requires base and head on a range source', () => {
  const doc = session({ source: { type: 'range' } });
  expect(at(doc, 'source.base').message).toBe('"source.base" is required for a "range" source');
  expect(at(doc, 'source.head').message).toBe('"source.head" is required for a "range" source');
});

test('requires head on a commit source', () => {
  const doc = session({ source: { type: 'commit' } });
  expect(at(doc, 'source.head').message).toBe('"source.head" is required for a "commit" source');
  expect(issuesOf(doc).some((issue) => issue.path === 'source.base')).toBe(false);
});

test('leaves base and head optional on working-tree and staged sources', () => {
  expectValid(session({ source: { type: 'working-tree' } }));
  expectValid(session({ source: { type: 'staged' } }));
});

test('rejects a ref that git would read as an option', () => {
  const doc = session({ source: { type: 'commit', head: '--upload-pack=evil' } });
  expect(at(doc, 'source.head').message).toMatch(/must not start with "-"/);
});

test('rejects a guide without an html path', () => {
  expect(at(session({ guide: {} }), 'guide.html').message).toMatch(/non-empty string/);
});

test('rejects a guide path that escapes the session directory', () => {
  const issue = at(session({ guide: { html: '../../etc/passwd' } }), 'guide.html');
  expect(issue.message).toMatch(/must be a path inside the session directory/);
  expect(issue.hint).toMatch(/guide\/index\.html/);
});

test('rejects an unknown intent', () => {
  expect(at(session({ intent: 'review' }), 'intent').message).toMatch(
    /"walkthrough", "proposal" \(got "review"\)/,
  );
});

test('rejects a commit without a title', () => {
  expect(at(session({ commit: { body: 'why' } }), 'commit.title').message).toMatch(
    /non-empty string/,
  );
});

test('rejects a non-integer pr number', () => {
  expect(at(session({ pr: { number: '4132' } }), 'pr.number').message).toMatch(
    /must be a positive integer \(got "4132"\)/,
  );
});

test('rejects non-array chapters', () => {
  expect(at(session({ chapters: {} }), 'chapters').message).toMatch(
    /must be an array \(got object\)/,
  );
});

test('rejects non-array support', () => {
  expect(at(session({ support: {} }), 'support').message).toMatch(/must be an array when present/);
});

// --- chapters ---------------------------------------------------------------

test('rejects a chapter that is not an object', () => {
  expect(at(session({ chapters: ['core'] }), 'chapters[0]').message).toMatch(
    /chapter must be an object \(got string\)/,
  );
});

test('rejects an empty chapter id', () => {
  expect(at(session({ chapters: [chapter({ id: '' })] }), 'chapters[0].id').message).toMatch(
    /chapter "id" must be a non-empty string/,
  );
});

test('reports duplicate chapter ids and names the first use', () => {
  const doc = session({
    chapters: [chapter(), chapter({ stops: [stop({ id: 's2', hunkIds: ['src/b.ts:h1'] })] })],
  });
  const issue = at(doc, 'chapters[1].id');
  expect(issue.message).toBe('duplicate chapter id "c1" — already used at chapters[0].id');
});

test('rejects an empty chapter title', () => {
  const issue = at(session({ chapters: [chapter({ title: '' })] }), 'chapters[0].title');
  expect(issue.hint).toMatch(/never a file path/);
});

test('rejects a non-string chapter blurb', () => {
  expect(at(session({ chapters: [chapter({ blurb: [] })] }), 'chapters[0].blurb').message).toMatch(
    /must be a string when present/,
  );
});

test('accepts must and nice as a chapter priority', () => {
  expectValid(session({ chapters: [chapter({ priority: 'must' })] }));
  expectValid(session({ chapters: [chapter({ priority: 'nice' })] }));
});

test('rejects an unknown chapter priority', () => {
  const issue = at(session({ chapters: [chapter({ priority: 'low' })] }), 'chapters[0].priority');
  expect(issue.message).toBe('chapter "priority" must be one of "must", "nice" (got "low")');
  expect(issue.hint).toMatch(/the default is "must"/);
});

test('rejects non-array chapter stops', () => {
  expect(at(session({ chapters: [chapter({ stops: {} })] }), 'chapters[0].stops').message).toMatch(
    /chapter "stops" must be an array/,
  );
});

// --- stops ------------------------------------------------------------------

const withStop = (over: Json): Json => session({ chapters: [chapter({ stops: [stop(over)] })] });

test('rejects a stop that is not an object', () => {
  expect(
    at(session({ chapters: [chapter({ stops: [null] })] }), 'chapters[0].stops[0]').message,
  ).toMatch(/stop must be an object \(got null\)/);
});

test('rejects an empty stop id', () => {
  expect(at(withStop({ id: '' }), 'chapters[0].stops[0].id').message).toMatch(
    /stop "id" must be a non-empty string/,
  );
});

test('reports duplicate stop ids across different chapters', () => {
  const doc = session({
    chapters: [chapter(), chapter({ id: 'c2', stops: [stop({ hunkIds: ['src/b.ts:h1'] })] })],
  });
  const issue = at(doc, 'chapters[1].stops[0].id');
  expect(issue.message).toBe('duplicate stop id "s1" — already used at chapters[0].stops[0].id');
  expect(issue.hint).toMatch(/across the whole session/);
});

test('rejects an unknown stop kind', () => {
  expect(at(withStop({ kind: 'bug' }), 'chapters[0].stops[0].kind').message).toMatch(
    /"walkthrough", "finding", "question", "verify" \(got "bug"\)/,
  );
});

test('rejects an unknown severity', () => {
  const doc = withStop({ kind: 'finding', severity: 'critical' });
  expect(at(doc, 'chapters[0].stops[0].severity').message).toMatch(
    /"info", "minor", "major", "blocker" \(got "critical"\)/,
  );
});

test('rejects severity on a stop that is not a finding', () => {
  const issue = at(
    withStop({ kind: 'question', severity: 'major' }),
    'chapters[0].stops[0].severity',
  );
  expect(issue.message).toBe(
    'severity "major" is only meaningful on a finding — this stop\'s kind is "question"',
  );
  expect(issue.hint).toMatch(/set "kind": "finding"/);
});

test('rejects severity on a stop with no kind, naming the default', () => {
  const issue = at(withStop({ severity: 'info' }), 'chapters[0].stops[0].severity');
  expect(issue.message).toMatch(/"walkthrough" \(the default\)/);
});

test('accepts severity on a finding', () => {
  expectValid(withStop({ kind: 'finding', severity: 'blocker' }));
});

test('accepts must and nice as a stop priority, including against its chapter', () => {
  expectValid(withStop({ priority: 'must' }));
  expectValid(
    session({ chapters: [chapter({ priority: 'nice', stops: [stop({ priority: 'must' })] })] }),
  );
});

test('rejects an unknown stop priority', () => {
  const issue = at(withStop({ priority: 'optional' }), 'chapters[0].stops[0].priority');
  expect(issue.message).toBe('stop "priority" must be one of "must", "nice" (got "optional")');
  expect(issue.hint).toMatch(/easily reversible/);
});

test('accepts a session where every declared priority is nice', () => {
  expectValid(
    session({
      chapters: [
        chapter({
          priority: 'nice',
          blurb: 'Dev-only scripts; nothing ships to users.',
          stops: [stop({ priority: 'nice' })],
        }),
      ],
    }),
  );
});

test('rejects a stop title over the limit', () => {
  const issue = at(
    withStop({ title: 'x'.repeat(STOP_TITLE_MAX + 1) }),
    'chapters[0].stops[0].title',
  );
  expect(issue.message).toBe(
    `stop "title" is ${STOP_TITLE_MAX + 1} characters — the limit is ${STOP_TITLE_MAX}`,
  );
});

test('accepts a stop title exactly at the limit', () => {
  expectValid(withStop({ title: 'x'.repeat(STOP_TITLE_MAX) }));
});

test('rejects empty prose', () => {
  const issue = at(withStop({ prose: '' }), 'chapters[0].stops[0].prose');
  expect(issue.hint).toMatch(/no headings, no lists/);
});

test('rejects non-array hunkIds', () => {
  expect(at(withStop({ hunkIds: 'src/a.ts:h1' }), 'chapters[0].stops[0].hunkIds').message).toMatch(
    /must be an array of hunk ids/,
  );
});

test('rejects a malformed hunk id, quoting the value and the expected form', () => {
  const issue = at(withStop({ hunkIds: ['src/a.ts'] }), 'chapters[0].stops[0].hunkIds[0]');
  expect(issue.message).toBe('hunk id "src/a.ts" does not match ^.+:h[1-9][0-9]*$');
  expect(issue.hint).toMatch(/"<path>:h<n>"/);
  expect(issue.hint).toMatch(/1-based/);
});

test('rejects a non-string hunk id', () => {
  expect(at(withStop({ hunkIds: [1] }), 'chapters[0].stops[0].hunkIds[0]').message).toMatch(
    /hunk id must be a string \(got number\)/,
  );
});

test('reports a hunk claimed twice by two stops, naming both owners', () => {
  const doc = session({
    chapters: [chapter({ stops: [stop(), stop({ id: 's2' })] })],
  });
  const issue = at(doc, 'chapters[0].stops[1].hunkIds[0]');
  expect(issue.message).toBe(
    'hunk "src/a.ts:h1" is already claimed by stop "s1" (chapters[0].stops[0].hunkIds[0])',
  );
  expect(issue.hint).toMatch(/exactly one stop or support group/);
});

test('reports a hunk claimed by both a stop and a support group', () => {
  const doc = session({ support: [{ id: 'gen', reason: 'generated', hunkIds: ['src/a.ts:h1'] }] });
  expect(at(doc, 'support[0].hunkIds[0]').message).toMatch(
    /already claimed by stop "s1" \(chapters\[0\]\.stops\[0\]\.hunkIds\[0\]\)/,
  );
});

test('reports a hunk repeated inside one stop', () => {
  const doc = withStop({ hunkIds: ['src/a.ts:h1', 'src/a.ts:h1'] });
  expect(at(doc, 'chapters[0].stops[0].hunkIds[1]').message).toMatch(
    /already claimed by stop "s1"/,
  );
});

test('rejects a stop that points at nothing', () => {
  const bare = stop();
  delete bare['hunkIds'];
  const issue = at(session({ chapters: [chapter({ stops: [bare] })] }), 'chapters[0].stops[0]');
  expect(issue.message).toBe('stop "s1" points at nothing — add hunkIds or anchors');
});

test('treats empty hunkIds and anchors arrays as pointing at nothing', () => {
  const issue = at(withStop({ hunkIds: [], anchors: [] }), 'chapters[0].stops[0]');
  expect(issue.message).toMatch(/points at nothing/);
});

test('rejects non-array anchors', () => {
  expect(at(withStop({ anchors: {} }), 'chapters[0].stops[0].anchors').message).toMatch(
    /stop "anchors" must be an array/,
  );
});

test('rejects an anchor that is not an object', () => {
  expect(at(withStop({ anchors: ['a.ts'] }), 'chapters[0].stops[0].anchors[0]').message).toMatch(
    /anchor must be an object/,
  );
});

const withAnchor = (over: Json): Json =>
  withStop({ anchors: [{ path: 'src/api/client.ts', side: 'head', start: 10, end: 20, ...over }] });

test('rejects an anchor without a path', () => {
  expect(at(withAnchor({ path: '' }), 'chapters[0].stops[0].anchors[0].path').message).toMatch(
    /anchor "path" must be a non-empty string/,
  );
});

test('rejects an unknown anchor side', () => {
  expect(at(withAnchor({ side: 'left' }), 'chapters[0].stops[0].anchors[0].side').message).toMatch(
    /"base", "head" \(got "left"\)/,
  );
});

test('rejects an anchor starting before line 1', () => {
  expect(at(withAnchor({ start: 0 }), 'chapters[0].stops[0].anchors[0].start').message).toMatch(
    /integer line number >= 1 \(got number\)/,
  );
});

test('rejects an anchor ending before it starts', () => {
  const issue = at(withAnchor({ start: 20, end: 10 }), 'chapters[0].stops[0].anchors[0].end');
  expect(issue.message).toBe('anchor "end" (10) is before "start" (20)');
});

test('accepts a single-line anchor', () => {
  expectValid(withAnchor({ start: 42, end: 42 }));
});

test('rejects a non-string anchor context', () => {
  expect(at(withAnchor({ context: 3 }), 'chapters[0].stops[0].anchors[0].context').message).toMatch(
    /must be a string when present/,
  );
});

test('rejects a suggestion without a patch', () => {
  expect(at(withStop({ suggestion: {} }), 'chapters[0].stops[0].suggestion.patch').message).toMatch(
    /"suggestion.patch" must be a non-empty string/,
  );
});

test('rejects a non-array checks field', () => {
  expect(at(withStop({ checks: 'run the tests' }), 'chapters[0].stops[0].checks').message).toMatch(
    /must be an array of strings/,
  );
});

test('rejects an empty check entry', () => {
  expect(at(withStop({ checks: [''] }), 'chapters[0].stops[0].checks[0]').message).toMatch(
    /check must be a non-empty string/,
  );
});

// --- support ----------------------------------------------------------------

const withSupport = (over: Json): Json =>
  session({
    support: [{ id: 'lockfile', reason: 'generated', hunkIds: ['pnpm-lock.yaml:h1'], ...over }],
  });

test('rejects a support group that is not an object', () => {
  expect(at(session({ support: [7] }), 'support[0]').message).toMatch(
    /support group must be an object \(got number\)/,
  );
});

test('rejects an empty support group id', () => {
  expect(at(withSupport({ id: '' }), 'support[0].id').message).toMatch(
    /support group "id" must be a non-empty string/,
  );
});

test('reports duplicate support group ids', () => {
  const doc = session({
    support: [
      { id: 'gen', reason: 'generated', hunkIds: ['a.ts:h1'] },
      { id: 'gen', reason: 'generated', hunkIds: ['b.ts:h1'] },
    ],
  });
  expect(at(doc, 'support[1].id').message).toBe(
    'duplicate support group id "gen" — already used at support[0].id',
  );
});

test('rejects a support group without a reason', () => {
  const issue = at(withSupport({ reason: '' }), 'support[0].reason');
  expect(issue.hint).toMatch(/"generated", "lockfile", "mechanical rename"/);
});

test('rejects a non-string support note', () => {
  expect(at(withSupport({ note: false }), 'support[0].note').message).toMatch(
    /must be a string when present/,
  );
});

test('rejects a support group with no hunk ids', () => {
  const issue = at(withSupport({ hunkIds: [] }), 'support[0].hunkIds');
  expect(issue.message).toBe('support group "hunkIds" must list at least one hunk id');
});

test('rejects a malformed hunk id in a support group', () => {
  expect(
    at(withSupport({ hunkIds: ['pnpm-lock.yaml:h0'] }), 'support[0].hunkIds[0]').message,
  ).toMatch(/does not match/);
});

// --- exhaustiveness ---------------------------------------------------------

test('collects every error instead of stopping at the first', () => {
  const doc = {
    version: 99,
    kind: 'nope',
    title: '',
    source: { type: 'branch' },
    chapters: [{ id: '', title: '', stops: [{ id: '', prose: '', hunkIds: ['bad'] }] }],
    support: [{ id: '', reason: '', hunkIds: [] }],
  };
  const paths = issuesOf(doc).map((issue) => issue.path);
  expect(paths).toEqual([
    'version',
    'kind',
    'title',
    'source.type',
    'chapters[0].id',
    'chapters[0].title',
    'chapters[0].stops[0].id',
    'chapters[0].stops[0].prose',
    'chapters[0].stops[0].hunkIds[0]',
    'support[0].id',
    'support[0].reason',
    'support[0].hunkIds',
  ]);
});

test('every issue carries a hint an agent can act on', () => {
  const doc = { version: 99, kind: 'nope', title: '', chapters: 'no', support: 'no' };
  const all = issuesOf(doc);
  expect(all.length).toBeGreaterThan(0);
  for (const issue of all) {
    expect(issue.hint, `no hint on ${issue.path}: ${issue.message}`).toBeTruthy();
  }
});

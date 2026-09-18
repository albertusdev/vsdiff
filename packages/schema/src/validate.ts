// The strict write path (D2): `vsdiff validate`. Every message is written to be
// pasted straight into an agent's context, so it must say what is wrong AND what
// to write instead. Never stop at the first problem — an agent that gets one
// error per round trip burns a turn per typo.

import { isRecord } from './parse.ts';
import { HUNK_ID_PATTERN, isHunkId } from './hunk-id.ts';
import {
  ANCHOR_SIDES,
  PRIORITIES,
  SCHEMA_VERSION,
  SESSION_INTENTS,
  SESSION_SOURCE_TYPES,
  SEVERITIES,
  STOP_KINDS,
  CHAPTER_BLURB_MAX,
  CHAPTER_TITLE_MAX,
  COMMIT_TITLE_MAX,
  FOCUS_MAX,
  SESSION_TITLE_MAX,
  STOP_PROSE_MAX,
  STOP_TITLE_MAX,
  SUPPORT_NOTE_MAX,
  SUPPORT_REASON_MAX,
  type ReviewSession,
} from './types.ts';

export interface ValidationIssue {
  /** `chapters[0].stops[2].hunkIds[1]`; `$` is the document itself. */
  path: string;
  message: string;
  hint?: string;
}

export type ValidationResult =
  | { ok: true; session: ReviewSession }
  | { ok: false; errors: ValidationIssue[] };

const ROOT = '$';

const HUNK_ID_HINT =
  'write "<path>:h<n>": the repo-relative path, then the 1-based number of the hunk ' +
  "counted from the top of that file's patch in the session's source diff — " +
  'e.g. "src/auth/middleware.ts:h2".';

const PRIORITY_HINT =
  'omit it — the default is "must" — for anything the reviewer has to judge; "nice" marks ' +
  'internal-facing, easily reversible changes, and then the blurb or prose must say why in one line.';

const typeName = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : typeName(v));

const list = (values: readonly string[]): string => values.map((v) => `"${v}"`).join(', ');

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** `priority` is spelled the same on a chapter and on a stop; unset means "must". */
function checkPriority(
  issues: Issues,
  raw: Record<string, unknown>,
  path: string,
  owner: 'chapter' | 'stop',
): void {
  const priority = raw['priority'];
  if (priority === undefined || PRIORITIES.includes(priority as never)) return;
  issues.add(
    `${path}.priority`,
    `${owner} "priority" must be one of ${list(PRIORITIES)} (got ${show(priority)})`,
    PRIORITY_HINT,
  );
}

/** Length budgets keep sessions skimmable; every overrun gets the same shape. */
function tooLong(
  issues: Issues,
  path: string,
  field: string,
  value: unknown,
  max: number,
  hint: string,
): void {
  if (typeof value === 'string' && value.length > max) {
    issues.add(path, `${field} is ${value.length} characters — the limit is ${max}`, hint);
  }
}

class Issues {
  readonly all: ValidationIssue[] = [];

  add(path: string, message: string, hint?: string): void {
    this.all.push(hint === undefined ? { path, message } : { path, message, hint });
  }

  /** Reports a wrong-typed optional field; returns true when the field is usable. */
  optionalString(
    parent: Record<string, unknown>,
    key: string,
    path: string,
    hint: string,
  ): boolean {
    const value = parent[key];
    if (value === undefined) return false;
    if (typeof value !== 'string') {
      this.add(path, `"${key}" must be a string when present (got ${typeName(value)})`, hint);
      return false;
    }
    return true;
  }
}

export function validateSession(input: string | unknown): ValidationResult {
  const issues = new Issues();

  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: ROOT,
            message: `not valid JSON: ${(error as Error).message}`,
            hint: 'a session is one plain JSON object — no comments, no trailing commas.',
          },
        ],
      };
    }
  }

  if (!isRecord(data)) {
    return {
      ok: false,
      errors: [
        {
          path: ROOT,
          message: `session must be a JSON object (got ${typeName(data)})`,
          hint: 'the top level carries "version", "kind", "title", "source" and "chapters".',
        },
      ],
    };
  }

  checkTopLevel(issues, data);

  // One hunk belongs to exactly one place in the session; remember who claimed it
  // first so the second claim can name both owners.
  const claims = new Map<string, string>();
  checkChapters(issues, data['chapters'], claims);
  checkSupport(issues, data['support'], claims);

  if (issues.all.length > 0) return { ok: false, errors: issues.all };
  return { ok: true, session: data as unknown as ReviewSession };
}

function checkTopLevel(issues: Issues, data: Record<string, unknown>): void {
  if (data['version'] !== SCHEMA_VERSION) {
    issues.add(
      'version',
      `"version" must be the number ${SCHEMA_VERSION} (got ${show(data['version'])})`,
      `this build reads Review Session v${SCHEMA_VERSION}; write "version": ${SCHEMA_VERSION}.`,
    );
  }
  if (data['kind'] !== 'review') {
    issues.add(
      'kind',
      `"kind" must be "review" (got ${show(data['kind'])})`,
      'write "kind": "review" — it is the only document kind vsdiff reads.',
    );
  }
  if (!isNonEmptyString(data['title'])) {
    issues.add(
      'title',
      `"title" must be a non-empty string (got ${show(data['title'])})`,
      'name the change in a few words, e.g. "Auth flow refactor".',
    );
  }
  tooLong(
    issues,
    'title',
    '"title"',
    data['title'],
    SESSION_TITLE_MAX,
    'name the change in a few words; detail belongs in "focus" or stop prose.',
  );
  issues.optionalString(
    data,
    'focus',
    'focus',
    'one or two sentences naming what the reviewer should watch, or omit the field.',
  );
  tooLong(
    issues,
    'focus',
    '"focus"',
    data['focus'],
    FOCUS_MAX,
    'keep focus to one or two sentences — long orientation belongs in stop prose.',
  );

  checkSource(issues, data['source']);
  checkGuide(issues, data['guide']);

  const intent = data['intent'];
  if (intent !== undefined && !SESSION_INTENTS.includes(intent as never)) {
    issues.add(
      'intent',
      `"intent" must be one of ${list(SESSION_INTENTS)} (got ${show(intent)})`,
      'omit it for a normal walkthrough; use "proposal" only when the stops are draft review comments awaiting triage.',
    );
  }

  checkCommit(issues, data['commit']);
  checkPr(issues, data['pr']);

  if (!Array.isArray(data['chapters'])) {
    issues.add(
      'chapters',
      `"chapters" must be an array (got ${typeName(data['chapters'])})`,
      'use [] when there is no guided path yet — every changed hunk then lands in the uncovered group.',
    );
  }
  if (data['support'] !== undefined && !Array.isArray(data['support'])) {
    issues.add(
      'support',
      `"support" must be an array when present (got ${typeName(data['support'])})`,
      'each entry is { "id", "reason", "hunkIds" } for changes kept off the main path.',
    );
  }
}

function checkSource(issues: Issues, source: unknown): void {
  const hint =
    'e.g. { "type": "range", "base": "main", "head": "HEAD" }, or { "type": "working-tree" }.';
  if (!isRecord(source)) {
    issues.add(
      'source',
      `"source" must be an object naming the diff this session anchors against (got ${typeName(source)})`,
      hint,
    );
    return;
  }
  const type = source['type'];
  if (!SESSION_SOURCE_TYPES.includes(type as never)) {
    issues.add(
      'source.type',
      `"source.type" must be one of ${list(SESSION_SOURCE_TYPES)} (got ${show(type)})`,
      hint,
    );
  }
  // `commit` and `range` cannot be resolved without their refs — the git engine
  // throws on them, so catching it here is the whole point of `vsdiff validate`.
  checkRef(issues, source, 'base', type === 'range' ? (type as string) : null);
  checkRef(issues, source, 'head', type === 'range' || type === 'commit' ? (type as string) : null);
}

/** `requiredFor` names the source type that needs this ref, or null when optional. */
function checkRef(
  issues: Issues,
  source: Record<string, unknown>,
  key: 'base' | 'head',
  requiredFor: string | null,
): void {
  const side = key === 'base' ? 'old' : 'new';
  const example = key === 'base' ? '"main"' : '"HEAD"';
  const value = source[key];

  if (value === undefined) {
    if (requiredFor !== null) {
      issues.add(
        `source.${key}`,
        `"source.${key}" is required for a "${requiredFor}" source`,
        `name the ${side} side of the diff, e.g. "${key}": ${example}.`,
      );
    }
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    issues.add(
      `source.${key}`,
      `"source.${key}" must be a non-empty string (got ${show(value)})`,
      `a ref or SHA for the ${side} side, e.g. ${example}.`,
    );
    return;
  }
  if (value.startsWith('-')) {
    issues.add(
      `source.${key}`,
      `"source.${key}" must not start with "-" (got ${show(value)})`,
      'git would read it as an option; use a ref, a SHA, or "./-weird-name".',
    );
  }
}

function checkGuide(issues: Issues, guide: unknown): void {
  if (guide === undefined) return;
  const hint = 'write { "html": "guide/index.html" }, relative to the session directory.';
  if (!isRecord(guide)) {
    issues.add('guide', `"guide" must be an object (got ${typeName(guide)})`, hint);
    return;
  }
  const html = guide['html'];
  if (!isNonEmptyString(html)) {
    issues.add('guide.html', `"guide.html" must be a non-empty string (got ${show(html)})`, hint);
    return;
  }
  if (!isSessionRelativePath(html)) {
    issues.add(
      'guide.html',
      `"guide.html" must be a path inside the session directory (got ${show(html)})`,
      'no leading "/", no "..", no URL — write it relative to the session folder, e.g. "guide/index.html".',
    );
  }
}

function isSessionRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

function checkCommit(issues: Issues, commit: unknown): void {
  if (commit === undefined) return;
  const hint = 'write { "title": "auth: move refresh into middleware", "body": "…" }.';
  if (!isRecord(commit)) {
    issues.add('commit', `"commit" must be an object (got ${typeName(commit)})`, hint);
    return;
  }
  if (!isNonEmptyString(commit['title'])) {
    issues.add(
      'commit.title',
      `"commit.title" must be a non-empty string (got ${show(commit['title'])})`,
      'one imperative subject line — it pre-fills the SCM input box.',
    );
  }
  tooLong(
    issues,
    'commit.title',
    '"commit.title"',
    commit['title'],
    COMMIT_TITLE_MAX,
    'subject lines truncate in git UIs around 72 characters; move detail to "body".',
  );
  issues.optionalString(
    commit,
    'body',
    'commit.body',
    'the rest of the commit message, or omit the field.',
  );
}

function checkPr(issues: Issues, pr: unknown): void {
  if (pr === undefined) return;
  const hint = 'write { "number": 4132, "headSha": "<40-char sha>" }.';
  if (!isRecord(pr)) {
    issues.add('pr', `"pr" must be an object (got ${typeName(pr)})`, hint);
    return;
  }
  const number = pr['number'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    issues.add(
      'pr.number',
      `"pr.number" must be a positive integer (got ${show(number)})`,
      'the pull request number as GitHub shows it, e.g. 4132.',
    );
  }
  issues.optionalString(
    pr,
    'headSha',
    'pr.headSha',
    'the PR head SHA the session was authored against, so publishing can refuse when the PR moved.',
  );
}

function checkChapters(issues: Issues, chapters: unknown, claims: Map<string, string>): void {
  if (!Array.isArray(chapters)) return; // already reported by checkTopLevel

  const chapterIds = new Map<string, string>();
  const stopIds = new Map<string, string>();

  for (const [i, raw] of chapters.entries()) {
    const path = `chapters[${i}]`;
    if (!isRecord(raw)) {
      issues.add(
        path,
        `chapter must be an object (got ${typeName(raw)})`,
        'a chapter is { "id", "title", "stops" } — a conceptual group, not a file.',
      );
      continue;
    }

    const id = raw['id'];
    if (!isNonEmptyString(id)) {
      issues.add(
        `${path}.id`,
        `chapter "id" must be a non-empty string (got ${show(id)})`,
        'a short slug the outline and deep links refer to, e.g. "core".',
      );
    } else {
      const first = chapterIds.get(id);
      if (first !== undefined) {
        issues.add(
          `${path}.id`,
          `duplicate chapter id ${show(id)} — already used at ${first}`,
          'chapter ids must be unique across the session; rename this one.',
        );
      } else {
        chapterIds.set(id, `${path}.id`);
      }
    }

    if (!isNonEmptyString(raw['title'])) {
      issues.add(
        `${path}.title`,
        `chapter "title" must be a non-empty string (got ${show(raw['title'])})`,
        'name the idea the chapter groups, e.g. "Middleware" — never a file path.',
      );
    }
    tooLong(
      issues,
      `${path}.title`,
      'chapter "title"',
      raw['title'],
      CHAPTER_TITLE_MAX,
      'chapter titles are tree labels — one or two short words like "Capture" or "Auth".',
    );
    issues.optionalString(
      raw,
      'blurb',
      `${path}.blurb`,
      'one sentence on why this chapter comes where it does, or omit it.',
    );
    tooLong(
      issues,
      `${path}.blurb`,
      'chapter "blurb"',
      raw['blurb'],
      CHAPTER_BLURB_MAX,
      "one sentence; anything longer belongs in a stop's prose.",
    );
    checkPriority(issues, raw, path, 'chapter');

    const stops = raw['stops'];
    if (!Array.isArray(stops)) {
      issues.add(
        `${path}.stops`,
        `chapter "stops" must be an array (got ${typeName(stops)})`,
        'list the review path for this chapter, one review idea per stop.',
      );
      continue;
    }
    for (const [j, stop] of stops.entries()) {
      checkStop(issues, stop, `${path}.stops[${j}]`, stopIds, claims);
    }
  }
}

function checkStop(
  issues: Issues,
  raw: unknown,
  path: string,
  stopIds: Map<string, string>,
  claims: Map<string, string>,
): void {
  if (!isRecord(raw)) {
    issues.add(
      path,
      `stop must be an object (got ${typeName(raw)})`,
      'a stop is { "id", "prose", "hunkIds" } plus optional kind/severity/title/anchors.',
    );
    return;
  }

  const id = raw['id'];
  let label = path;
  if (!isNonEmptyString(id)) {
    issues.add(
      `${path}.id`,
      `stop "id" must be a non-empty string (got ${show(id)})`,
      'feedback events and deep links address stops by id; use a short slug like "refresh-race".',
    );
  } else {
    label = `stop ${show(id)}`;
    const first = stopIds.get(id);
    if (first !== undefined) {
      issues.add(
        `${path}.id`,
        `duplicate stop id ${show(id)} — already used at ${first}`,
        'stop ids must be unique across the whole session, not just within a chapter.',
      );
    } else {
      stopIds.set(id, `${path}.id`);
    }
  }

  const kind = raw['kind'];
  const kindValid = kind === undefined || STOP_KINDS.includes(kind as never);
  if (!kindValid) {
    issues.add(
      `${path}.kind`,
      `stop "kind" must be one of ${list(STOP_KINDS)} (got ${show(kind)})`,
      'omit it for a plain walkthrough stop; "finding" flags a problem, "question" asks the ' +
        'author, "verify" asks the reviewer to check something.',
    );
  }

  const severity = raw['severity'];
  if (severity !== undefined) {
    if (!SEVERITIES.includes(severity as never)) {
      issues.add(
        `${path}.severity`,
        `stop "severity" must be one of ${list(SEVERITIES)} (got ${show(severity)})`,
        'severity ranks findings only: "info", "minor", "major", "blocker".',
      );
    } else if (kindValid && kind !== 'finding') {
      const actual = kind === undefined ? '"walkthrough" (the default)' : show(kind);
      issues.add(
        `${path}.severity`,
        `severity ${show(severity)} is only meaningful on a finding — this stop's kind is ${actual}`,
        'set "kind": "finding" if this really is a finding, otherwise drop "severity".',
      );
    }
  }

  checkPriority(issues, raw, path, 'stop');

  const titleHint =
    'a semantic 2-6 word title, e.g. "Concurrent refresh can double-issue tokens" — never a file path.';
  if (issues.optionalString(raw, 'title', `${path}.title`, titleHint)) {
    const title = raw['title'] as string;
    if (title.length > STOP_TITLE_MAX) {
      issues.add(
        `${path}.title`,
        `stop "title" is ${title.length} characters — the limit is ${STOP_TITLE_MAX}`,
        'titles render in the outline tree; keep it to roughly 2-6 words and move the detail into "prose".',
      );
    }
  }

  if (!isNonEmptyString(raw['prose'])) {
    issues.add(
      `${path}.prose`,
      `stop "prose" must be a non-empty string (got ${show(raw['prose'])})`,
      'one or two sentences of inline markdown saying what to look at and why — no headings, no lists.',
    );
  }
  tooLong(
    issues,
    `${path}.prose`,
    'stop "prose"',
    raw['prose'],
    STOP_PROSE_MAX,
    'split a long narrative into more stops — one review idea per stop.',
  );

  const hunkIds = raw['hunkIds'];
  let hunkIdsUsable = true;
  if (hunkIds !== undefined) {
    if (!Array.isArray(hunkIds)) {
      issues.add(
        `${path}.hunkIds`,
        `stop "hunkIds" must be an array of hunk ids (got ${typeName(hunkIds)})`,
        HUNK_ID_HINT,
      );
      hunkIdsUsable = false;
    } else {
      for (const [i, value] of hunkIds.entries()) {
        checkHunkId(issues, value, `${path}.hunkIds[${i}]`, label, claims);
      }
    }
  }

  const anchors = raw['anchors'];
  let anchorsUsable = true;
  if (anchors !== undefined) {
    if (!Array.isArray(anchors)) {
      issues.add(
        `${path}.anchors`,
        `stop "anchors" must be an array (got ${typeName(anchors)})`,
        'each anchor is { "path", "side", "start", "end" } — use anchors to point at unchanged code.',
      );
      anchorsUsable = false;
    } else {
      for (const [i, anchor] of anchors.entries()) {
        checkAnchor(issues, anchor, `${path}.anchors[${i}]`);
      }
    }
  }

  const hasHunks = Array.isArray(hunkIds) && hunkIds.length > 0;
  const hasAnchors = Array.isArray(anchors) && anchors.length > 0;
  if (!hasHunks && !hasAnchors && hunkIdsUsable && anchorsUsable) {
    issues.add(
      path,
      `${label} points at nothing — add hunkIds or anchors`,
      'every stop must land the reviewer somewhere: "hunkIds" for changed code, "anchors" for a line range in any file.',
    );
  }

  checkSuggestion(issues, raw['suggestion'], path);
  checkChecks(issues, raw['checks'], path);
}

function checkHunkId(
  issues: Issues,
  value: unknown,
  path: string,
  owner: string,
  claims: Map<string, string>,
): void {
  if (typeof value !== 'string') {
    issues.add(path, `hunk id must be a string (got ${typeName(value)})`, HUNK_ID_HINT);
    return;
  }
  if (!isHunkId(value)) {
    issues.add(path, `hunk id ${show(value)} does not match ${HUNK_ID_PATTERN}`, HUNK_ID_HINT);
    return;
  }
  const first = claims.get(value);
  if (first !== undefined) {
    issues.add(
      path,
      `hunk ${show(value)} is already claimed by ${first}`,
      'a hunk belongs to exactly one stop or support group — remove it from one of them.',
    );
    return;
  }
  claims.set(value, `${owner} (${path})`);
}

function checkAnchor(issues: Issues, raw: unknown, path: string): void {
  if (!isRecord(raw)) {
    issues.add(
      path,
      `anchor must be an object (got ${typeName(raw)})`,
      'write { "path": "src/api/client.ts", "side": "head", "start": 88, "end": 96 }.',
    );
    return;
  }

  if (!isNonEmptyString(raw['path'])) {
    issues.add(
      `${path}.path`,
      `anchor "path" must be a non-empty string (got ${show(raw['path'])})`,
      'the repo-relative path of the file the reviewer should open.',
    );
  }
  if (!ANCHOR_SIDES.includes(raw['side'] as never)) {
    issues.add(
      `${path}.side`,
      `anchor "side" must be one of ${list(ANCHOR_SIDES)} (got ${show(raw['side'])})`,
      'use "head" for line numbers in the new version of the file, "base" for the old one.',
    );
  }

  const start = raw['start'];
  const end = raw['end'];
  const startOk = typeof start === 'number' && Number.isInteger(start) && start >= 1;
  if (!startOk) {
    issues.add(
      `${path}.start`,
      `anchor "start" must be an integer line number >= 1 (got ${show(start)})`,
      'line numbers are 1-based and inclusive.',
    );
  }
  const endOk = typeof end === 'number' && Number.isInteger(end) && end >= 1;
  if (!endOk) {
    issues.add(
      `${path}.end`,
      `anchor "end" must be an integer line number >= 1 (got ${show(end)})`,
      'line numbers are 1-based and inclusive; use the same value as "start" for a single line.',
    );
  } else if (startOk && end < start) {
    issues.add(
      `${path}.end`,
      `anchor "end" (${end}) is before "start" (${start})`,
      'the range runs start..end inclusive — swap them, or set "end" to at least "start".',
    );
  }

  issues.optionalString(
    raw,
    'context',
    `${path}.context`,
    'a short snippet from the anchored lines; it is what relocates the anchor when the file drifts.',
  );
}

function checkSuggestion(issues: Issues, suggestion: unknown, stopPath: string): void {
  if (suggestion === undefined) return;
  const hint = 'write { "patch": "--- a/…\\n+++ b/…\\n@@ …" } — a unified diff, or omit the field.';
  if (!isRecord(suggestion)) {
    issues.add(
      `${stopPath}.suggestion`,
      `stop "suggestion" must be an object (got ${typeName(suggestion)})`,
      hint,
    );
    return;
  }
  if (!isNonEmptyString(suggestion['patch'])) {
    issues.add(
      `${stopPath}.suggestion.patch`,
      `"suggestion.patch" must be a non-empty string (got ${show(suggestion['patch'])})`,
      hint,
    );
  }
}

function checkChecks(issues: Issues, checks: unknown, stopPath: string): void {
  if (checks === undefined) return;
  const hint =
    'each entry is one thing the reviewer should confirm, e.g. "Confirm single-flight behavior under two parallel 401s".';
  if (!Array.isArray(checks)) {
    issues.add(
      `${stopPath}.checks`,
      `stop "checks" must be an array of strings (got ${typeName(checks)})`,
      hint,
    );
    return;
  }
  for (const [i, value] of checks.entries()) {
    if (!isNonEmptyString(value)) {
      issues.add(
        `${stopPath}.checks[${i}]`,
        `check must be a non-empty string (got ${show(value)})`,
        hint,
      );
    }
  }
}

function checkSupport(issues: Issues, support: unknown, claims: Map<string, string>): void {
  if (!Array.isArray(support)) return; // absent, or already reported by checkTopLevel

  const groupIds = new Map<string, string>();

  for (const [i, raw] of support.entries()) {
    const path = `support[${i}]`;
    if (!isRecord(raw)) {
      issues.add(
        path,
        `support group must be an object (got ${typeName(raw)})`,
        'a support group is { "id", "reason", "hunkIds" } for changes kept off the main path.',
      );
      continue;
    }

    const id = raw['id'];
    let label = path;
    if (!isNonEmptyString(id)) {
      issues.add(
        `${path}.id`,
        `support group "id" must be a non-empty string (got ${show(id)})`,
        'a short slug, e.g. "lockfile".',
      );
    } else {
      label = `support group ${show(id)}`;
      const first = groupIds.get(id);
      if (first !== undefined) {
        issues.add(
          `${path}.id`,
          `duplicate support group id ${show(id)} — already used at ${first}`,
          'support group ids must be unique; rename this one or merge the two groups.',
        );
      } else {
        groupIds.set(id, `${path}.id`);
      }
    }

    if (!isNonEmptyString(raw['reason'])) {
      issues.add(
        `${path}.reason`,
        `support group "reason" must be a non-empty string (got ${show(raw['reason'])})`,
        'say why it is off the main path, e.g. "generated", "lockfile", "mechanical rename".',
      );
    }
    tooLong(
      issues,
      `${path}.reason`,
      'support group "reason"',
      raw['reason'],
      SUPPORT_REASON_MAX,
      'a short label like "generated" — detail goes in "note".',
    );
    issues.optionalString(
      raw,
      'note',
      `${path}.note`,
      'one extra sentence for the reviewer, or omit it.',
    );
    tooLong(
      issues,
      `${path}.note`,
      'support group "note"',
      raw['note'],
      SUPPORT_NOTE_MAX,
      'one sentence; if it needs more, it deserves a stop on the main path.',
    );

    const hunkIds = raw['hunkIds'];
    if (!Array.isArray(hunkIds)) {
      issues.add(
        `${path}.hunkIds`,
        `support group "hunkIds" must be an array (got ${typeName(hunkIds)})`,
        HUNK_ID_HINT,
      );
      continue;
    }
    if (hunkIds.length === 0) {
      issues.add(
        `${path}.hunkIds`,
        'support group "hunkIds" must list at least one hunk id',
        'a support group exists to park hunks — drop the group if it has none.',
      );
    }
    for (const [j, value] of hunkIds.entries()) {
      checkHunkId(issues, value, `${path}.hunkIds[${j}]`, label, claims);
    }
  }
}

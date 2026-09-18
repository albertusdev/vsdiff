// Review Session format v1 — the type contract (blueprint §6).
//
// Every level extends `Extensible`: unknown fields are part of the contract, not
// an accident. The loader never rebuilds these objects, so anything an agent
// writes survives a load/save round-trip verbatim. `x-` prefixed keys are
// reserved for agent experiments.

export const SCHEMA_VERSION = 1 as const;

/** Unknown fields pass through untouched (forward compatibility, D2). */
export interface Extensible {
  [extra: string]: unknown;
}

export type StopKind = 'walkthrough' | 'finding' | 'question' | 'verify';
export type Severity = 'info' | 'minor' | 'major' | 'blocker';
/** How a skimmer should treat a chapter or stop. Unset means `'must'`. */
export type Priority = 'must' | 'nice';
export type SessionIntent = 'walkthrough' | 'proposal';
export type AnchorSide = 'base' | 'head';
export type SessionSourceType = 'working-tree' | 'staged' | 'commit' | 'range';

export const STOP_KINDS: readonly StopKind[] = ['walkthrough', 'finding', 'question', 'verify'];
export const SEVERITIES: readonly Severity[] = ['info', 'minor', 'major', 'blocker'];
export const PRIORITIES: readonly Priority[] = ['must', 'nice'];
export const SESSION_INTENTS: readonly SessionIntent[] = ['walkthrough', 'proposal'];
export const ANCHOR_SIDES: readonly AnchorSide[] = ['base', 'head'];
export const SESSION_SOURCE_TYPES: readonly SessionSourceType[] = [
  'working-tree',
  'staged',
  'commit',
  'range',
];

/** Longest stop title the outline tree renders without truncating. */
/**
 * Length budgets for everything that renders in the outline tree or must stay
 * skimmable. The validator enforces them so agents keep sessions concise; the
 * editor additionally truncates on display as defense in depth.
 */
export const SESSION_TITLE_MAX = 80;
export const FOCUS_MAX = 240;
export const CHAPTER_TITLE_MAX = 24;
export const CHAPTER_BLURB_MAX = 140;
export const STOP_TITLE_MAX = 72;
export const STOP_PROSE_MAX = 2000;
export const SUPPORT_REASON_MAX = 48;
export const SUPPORT_NOTE_MAX = 140;
export const COMMIT_TITLE_MAX = 72;

/** A line range in a file — the only way to point at UNCHANGED code. */
export interface Anchor extends Extensible {
  path: string;
  side: AnchorSide;
  /** 1-based, inclusive. */
  start: number;
  /** 1-based, inclusive, never before `start`. */
  end: number;
  /** Snippet used to relocate the anchor when the file drifts. */
  context?: string;
}

export interface Suggestion extends Extensible {
  /** Unified diff the reviewer can apply. */
  patch: string;
}

export interface Stop extends Extensible {
  id: string;
  kind?: StopKind;
  /** Only meaningful when `kind` is `'finding'`. */
  severity?: Severity;
  /** Overrides the chapter's priority; unset inherits it, and an unset chapter is `'must'`. */
  priority?: Priority;
  title?: string;
  /** Inline markdown; no headings or lists. */
  prose: string;
  /** `path:h<n>` — the n-th hunk of that file's patch in the session's source diff. */
  hunkIds?: string[];
  anchors?: Anchor[];
  suggestion?: Suggestion;
  checks?: string[];
}

export interface Chapter extends Extensible {
  id: string;
  title: string;
  blurb?: string;
  /** Default for the chapter's stops; unset means `'must'`. */
  priority?: Priority;
  stops: Stop[];
}

/** Changed hunks deliberately kept off the main review path. */
export interface SupportGroup extends Extensible {
  id: string;
  reason: string;
  note?: string;
  hunkIds: string[];
}

export interface SessionSource extends Extensible {
  type: SessionSourceType;
  base?: string;
  head?: string;
}

/** Agent-authored HTML guide, path relative to the session directory (R14). */
export interface GuideRef extends Extensible {
  html: string;
}

/** Commit message proposal for working-tree sessions. */
export interface CommitProposal extends Extensible {
  title: string;
  body?: string;
}

/** Pins a GitHub-sourced session to the head it was authored against. */
export interface PullRequestRef extends Extensible {
  number: number;
  headSha?: string;
}

export interface ReviewSession extends Extensible {
  version: typeof SCHEMA_VERSION;
  kind: 'review';
  title: string;
  focus?: string;
  source: SessionSource;
  guide?: GuideRef;
  /** Defaults to `'walkthrough'`. */
  intent?: SessionIntent;
  commit?: CommitProposal;
  pr?: PullRequestRef;
  chapters: Chapter[];
  support?: SupportGroup[];
}

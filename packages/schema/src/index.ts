// Review Session format v1 — types, permissive parser, strict validator, JSON
// Schema. Zero runtime dependencies; runs anywhere (blueprint §6, §7.1).
//
// Two read modes on purpose (D2): `parseSession` is the loader — structural
// minimum, unknown fields pass through, optionals default downstream. Nothing in
// the editor should ever refuse to open a session over a nit. `validateSession`
// is `vsdiff validate`: strict, exhaustive, and every message written to be
// pasted into an agent's context.

export {
  CHAPTER_BLURB_MAX,
  CHAPTER_TITLE_MAX,
  COMMIT_TITLE_MAX,
  FOCUS_MAX,
  SCHEMA_VERSION,
  SESSION_TITLE_MAX,
  STOP_PROSE_MAX,
  STOP_TITLE_MAX,
  SUPPORT_NOTE_MAX,
  SUPPORT_REASON_MAX,
} from './types.ts';
export {
  ANCHOR_SIDES,
  PRIORITIES,
  SESSION_INTENTS,
  SESSION_SOURCE_TYPES,
  SEVERITIES,
  STOP_KINDS,
} from './types.ts';
export type {
  Anchor,
  AnchorSide,
  Chapter,
  CommitProposal,
  Extensible,
  GuideRef,
  Priority,
  PullRequestRef,
  ReviewSession,
  SessionIntent,
  SessionSource,
  SessionSourceType,
  Severity,
  Stop,
  StopKind,
  Suggestion,
  SupportGroup,
} from './types.ts';

export { parseSession } from './parse.ts';
export type { ParseResult } from './parse.ts';

export { validateSession } from './validate.ts';
export type { ValidationIssue, ValidationResult } from './validate.ts';

export { HUNK_ID_PATTERN, formatHunkId, isHunkId, parseHunkId } from './hunk-id.ts';
export type { ParsedHunkId } from './hunk-id.ts';

export { getJsonSchema } from './json-schema.ts';

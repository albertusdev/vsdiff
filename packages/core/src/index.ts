// @vsdiff/core — session engine: git diff, resolution, session loading.
// Hard rule: no `vscode` imports in this package (blueprint §7.1).

import { readFile } from 'node:fs/promises';
import { parseSession, type ParseResult } from '@vsdiff/schema';

export type { ReviewSession, Chapter, Stop, ParseResult } from '@vsdiff/schema';
export { parseSession, SCHEMA_VERSION } from '@vsdiff/schema';

export type { DiffFile, DiffHunk, DiffResult, Diffstat, FileStatus } from './types.ts';
export { computeDiff, diffstat, GitError, showFile } from './git.ts';
export { DiffParseError, parseUnifiedDiff } from './diff-parse.ts';
export { resolveSession } from './resolve.ts';
export type {
  CommentEvent,
  DoneEvent,
  FeedbackAuthor,
  FeedbackBatch,
  FeedbackEvent,
  ReadFeedbackOptions,
  ReplyEvent,
  ResolveEvent,
  ResultDoc,
  Thread,
  UnknownEvent,
  VerdictEvent,
  ViewedEvent,
} from './feedback-types.ts';
export type { NewFeedbackEvent } from './feedback.ts';
export {
  appendFeedback,
  buildThreads,
  readFeedback,
  readResult,
  summarizeVerdicts,
  waitForFeedback,
  writeResult,
} from './feedback.ts';
export type {
  ResolvedChapter,
  ResolvedHunkRef,
  ResolvedSession,
  ResolvedStop,
  ResolvedSupportGroup,
  UncoveredFile,
} from './resolve.ts';
export type {
  EditorChoice,
  EditorPresetName,
  EditorTarget,
  LoadedConfig,
  ResolvedEditor,
  VsdiffConfig,
} from './config.ts';
export {
  CONFIG_SCHEMA_URL,
  EDITOR_PRESETS,
  getConfigSchema,
  globalConfigPath,
  JsoncParseError,
  loadConfig,
  parseJsonc,
  persistDetectedEditor,
  repoConfigPath,
  resolveEditor,
} from './config.ts';

export async function loadSessionFile(path: string): Promise<ParseResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`cannot read ${path}: ${(error as Error).message}`] };
  }
  return parseSession(raw);
}

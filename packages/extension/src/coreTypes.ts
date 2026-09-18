// The extension's view of @vsdiff/core: re-exported types plus the runtime
// surface it feature-detects at activation (so a partially-built core degrades
// to an explicit "core pending" state instead of a crash).

import type { ReviewSession, SessionSource } from '@vsdiff/schema';
import type {
  DiffResult,
  FeedbackBatch,
  FeedbackEvent,
  NewFeedbackEvent,
  ReadFeedbackOptions,
  ResolvedSession,
  ResultDoc,
  Thread,
} from '@vsdiff/core';

export type {
  CommentEvent,
  DiffFile,
  DiffHunk,
  DiffResult,
  FileStatus,
  FeedbackBatch,
  FeedbackEvent,
  NewFeedbackEvent,
  ReplyEvent,
  ResolvedChapter,
  ResolvedHunkRef,
  ResolvedSession,
  ResolvedStop,
  ResolvedSupportGroup,
  ResultDoc,
  Thread,
  UncoveredFile,
  VerdictEvent,
} from '@vsdiff/core';

export interface CoreApi {
  computeDiff(repoRoot: string, source: SessionSource): Promise<DiffResult>;
  showFile(repoRoot: string, ref: string, path: string): Promise<Uint8Array | null>;
  resolveSession(session: ReviewSession, diff: DiffResult): ResolvedSession;
  appendFeedback(sessionDir: string, event: NewFeedbackEvent): Promise<void>;
  readFeedback(sessionDir: string, options?: ReadFeedbackOptions): Promise<FeedbackBatch>;
  buildThreads(events: FeedbackEvent[]): Thread[];
  summarizeVerdicts(events: FeedbackEvent[]): ResultDoc['verdicts'];
  writeResult(sessionDir: string, result: ResultDoc): Promise<void>;
}

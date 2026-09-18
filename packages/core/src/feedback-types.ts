// P2 public contract for the feedback channel (blueprint §6 "feedback.jsonl —
// the return channel"). This file is the seam between the extension (writer of
// human events), the CLI (reader + writer of agent events), and the --await
// handoff — changes here need tech-lead review.

export type FeedbackAuthor = 'human' | 'agent';

export interface CommentEvent {
  type: 'comment';
  ts: string;
  /** Thread id, unique within the session (e.g. "t1"). */
  id: string;
  path: string;
  /** 1-based line on `side` ('head' unless stated). */
  line: number;
  side?: 'base' | 'head';
  stop?: string;
  body: string;
  author: FeedbackAuthor;
}

export interface ReplyEvent {
  type: 'reply';
  ts: string;
  thread: string;
  body: string;
  author: FeedbackAuthor;
}

export interface VerdictEvent {
  type: 'verdict';
  ts: string;
  stop: string;
  verdict: 'accepted' | 'needs-work' | 'question';
}

export interface ViewedEvent {
  type: 'viewed';
  ts: string;
  path: string;
  viewed: boolean;
}

export interface ResolveEvent {
  type: 'resolve';
  ts: string;
  thread: string;
  by: FeedbackAuthor;
}

export interface DoneEvent {
  type: 'done';
  ts: string;
  status: 'approved' | 'changes-requested';
  note?: string;
}

/** Unknown event types are preserved and passed through, never dropped. */
export interface UnknownEvent {
  type: string;
  ts: string;
  [extra: string]: unknown;
}

export type FeedbackEvent =
  | CommentEvent
  | ReplyEvent
  | VerdictEvent
  | ViewedEvent
  | ResolveEvent
  | DoneEvent
  | UnknownEvent;

export interface ReadFeedbackOptions {
  /** Skip the first N raw lines (resume cursor from a prior read). */
  afterLine?: number;
}

export interface FeedbackBatch {
  events: FeedbackEvent[];
  /** Raw line count consumed — pass back as afterLine to resume. */
  nextLine: number;
  /** Lines that failed to parse (reported, never thrown). */
  malformed: number;
}

export interface Thread {
  id: string;
  root: CommentEvent;
  replies: ReplyEvent[];
  resolved: boolean;
  resolvedBy?: FeedbackAuthor;
}

export interface ResultDoc {
  status: 'approved' | 'changes-requested' | 'closed' | 'canceled';
  verdicts: { accepted: number; needsWork: number; questions: number };
  openThreads: string[];
  /** Latest verdict per stop id — disambiguates counters that survive rounds. */
  verdictsByStop?: Record<string, string>;
  /** Threads resolved at finish time. */
  resolvedThreads?: string[];
  /** Synthesized results only: whether any editor ever loaded the session. */
  attached?: boolean;
  /** Synthesized results only: why (e.g. 'timeout', 'aborted'). */
  reason?: string;
  note?: string;
  finishedAt: string;
}

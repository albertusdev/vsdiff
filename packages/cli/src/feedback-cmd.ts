// The agent's side of the return channel (blueprint §6): read what the human
// wrote, write back replies, resolves and agent-authored comments. Every write
// goes through core's `appendFeedback`, so the extension's watcher renders it
// into the open thread without any further coordination.

import { randomBytes } from 'node:crypto';
import {
  appendFeedback,
  readFeedback,
  waitForFeedback,
  type CommentEvent,
  type FeedbackBatch,
  type ReplyEvent,
  type ResolveEvent,
} from '@vsdiff/core';

export interface CollectOptions {
  /** Resume cursor: skip this many raw lines (a prior read's `nextLine`). */
  after?: number;
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CollectResult {
  batch: FeedbackBatch;
  /** True only for `--wait` that ran out of time with nothing new (exit 3). */
  timedOut: boolean;
}

export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

export async function collectFeedback(
  sessionDir: string,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const after = Math.max(0, Math.trunc(options.after ?? 0));
  if (options.wait !== true) {
    return { batch: await readFeedback(sessionDir, { afterLine: after }), timedOut: false };
  }
  const batch = await waitForFeedback(sessionDir, {
    afterLine: after,
    timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { batch, timedOut: batch.events.length === 0 };
}

/**
 * Thread ids only have to be unique within one session's log, so wall clock
 * plus two random bytes is enough — and it sorts by creation time, which makes
 * a log read by hand easier to follow.
 */
export function newThreadId(now: number = Date.now()): string {
  return `t${now}-${randomBytes(2).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function appendReply(
  sessionDir: string,
  input: { thread: string; body: string },
): Promise<ReplyEvent> {
  const event: ReplyEvent = {
    type: 'reply',
    ts: nowIso(),
    thread: input.thread,
    body: input.body,
    author: 'agent',
  };
  await appendFeedback(sessionDir, event);
  return event;
}

export async function appendResolve(
  sessionDir: string,
  input: { thread: string },
): Promise<ResolveEvent> {
  const event: ResolveEvent = {
    type: 'resolve',
    ts: nowIso(),
    thread: input.thread,
    by: 'agent',
  };
  await appendFeedback(sessionDir, event);
  return event;
}

export async function appendComment(
  sessionDir: string,
  input: { path: string; line: number; body: string; stop?: string | undefined; id?: string },
): Promise<CommentEvent> {
  const event: CommentEvent = {
    type: 'comment',
    ts: nowIso(),
    id: input.id ?? newThreadId(),
    path: input.path,
    line: input.line,
    body: input.body,
    author: 'agent',
    ...(input.stop === undefined ? {} : { stop: input.stop }),
  };
  await appendFeedback(sessionDir, event);
  return event;
}

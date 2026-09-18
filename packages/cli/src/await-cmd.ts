// The blocking handoff (blueprint §3): the agent parks here while a human
// reviews, and resumes on the `result.json` the extension writes on a terminal
// action. Two rules this file exists to enforce:
//   1. a previous run's result must never satisfy a new wait (stale delete);
//   2. timeout and cancel are never approval — both exit 2 (codiff's
//      plan-result semantics).

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readFeedback, readResult, type ResultDoc } from '@vsdiff/core';

const RESULT_FILE = 'result.json';
export const DEFAULT_POLL_MS = 500;

/** A synthesized result carries why it was synthesized; a real one has no `reason`. */
export type AwaitedResult = ResultDoc & { reason?: 'timeout' | 'aborted' };

export interface AwaitOptions {
  /** 0 (the default) waits forever — the human sets the pace. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<string> = new Set([
  'approved',
  'changes-requested',
  'closed',
  'canceled',
]);

export function isTerminalStatus(status: unknown): status is ResultDoc['status'] {
  return typeof status === 'string' && TERMINAL.has(status);
}

/** Only `canceled` (editor died, timeout, explicit cancel) is a failed handoff. */
export function exitCodeForStatus(status: ResultDoc['status']): number {
  return status === 'canceled' ? 2 : 0;
}

export function canceledResult(reason: 'timeout' | 'aborted', attached?: boolean): AwaitedResult {
  return {
    status: 'canceled',
    reason,
    ...(attached !== undefined ? { attached } : {}),
    verdicts: { accepted: 0, needsWork: 0, questions: 0 },
    openThreads: [],
    finishedAt: new Date().toISOString(),
  };
}

/** Whether any editor ever loaded this session (the 'opened' event). */
export async function sessionAttached(sessionDir: string): Promise<boolean> {
  const batch = await readFeedback(sessionDir);
  return batch.events.some((event) => event.type === 'opened');
}

/** Removes a previous run's result so it cannot satisfy this wait. */
export async function clearResult(sessionDir: string): Promise<void> {
  try {
    await unlink(join(sessionDir, RESULT_FILE));
  } catch {
    // Nothing to clear is the common case.
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Clears any stale result, then polls until the extension writes one with a
 * terminal status. A result whose status isn't terminal (a future in-progress
 * document) is ignored rather than returned — waiting is the safe default.
 */
export async function awaitResult(
  sessionDir: string,
  options: AwaitOptions = {},
): Promise<AwaitedResult> {
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const { signal } = options;

  await clearResult(sessionDir);

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  for (;;) {
    const result = await readResult(sessionDir);
    if (result !== null && isTerminalStatus(result.status)) return result;
    if (signal?.aborted === true)
      return canceledResult('aborted', await sessionAttached(sessionDir));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return canceledResult('timeout', await sessionAttached(sessionDir));
    await sleep(Math.min(pollMs, remaining), signal);
  }
}

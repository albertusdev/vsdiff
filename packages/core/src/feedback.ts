// feedback.jsonl — the return channel (blueprint §6): an append-only event log
// carrying the human↔agent review conversation, plus result.json, the terminal
// document a `--await` handoff resolves on. Two processes append to the log at
// once (extension + CLI), so a write is one O_APPEND write() and a read never
// throws on the torn tail a mid-append writer leaves behind.

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CommentEvent,
  FeedbackBatch,
  FeedbackEvent,
  ReadFeedbackOptions,
  ReplyEvent,
  ResultDoc,
  Thread,
} from './feedback-types.ts';

const FEEDBACK_FILE = 'feedback.jsonl';
const RESULT_FILE = 'result.json';

/** fs.watch misses events on some filesystems (network mounts, containers). */
const POLL_MS = 500;

/**
 * An event as authored: every other field matches `FeedbackEvent`, but `ts` is
 * stamped by `appendFeedback` when the caller leaves it out.
 */
export type NewFeedbackEvent = FeedbackEvent | (Omit<FeedbackEvent, 'ts'> & { ts?: string });

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Appends one event as a single line. The line is built before the file is
 * opened so a non-serialisable event can't leave a truncated write behind, and
 * it goes out in one `write()` on an 'a' handle: POSIX O_APPEND makes each such
 * write atomic, which is what keeps two concurrent writers from interleaving.
 */
export async function appendFeedback(sessionDir: string, event: NewFeedbackEvent): Promise<void> {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new Error('feedback event needs a string `type`');
  }
  const stamped =
    typeof event.ts === 'string' && event.ts.length > 0
      ? event
      : { ...event, ts: new Date().toISOString() };
  const line = Buffer.from(`${JSON.stringify(stamped)}\n`, 'utf8');

  await mkdir(sessionDir, { recursive: true });
  const handle = await open(join(sessionDir, FEEDBACK_FILE), 'a');
  try {
    await handle.write(line);
  } finally {
    await handle.close();
  }
}

/**
 * Reads the log from `afterLine` on. Malformed lines are counted and skipped,
 * never thrown; `nextLine` counts only newline-terminated lines, so a partial
 * line left by a mid-append writer is re-read once it is finished.
 */
export async function readFeedback(
  sessionDir: string,
  options: ReadFeedbackOptions = {},
): Promise<FeedbackBatch> {
  const afterLine = Math.max(0, Math.trunc(options.afterLine ?? 0));
  let raw: string;
  try {
    raw = await readFile(join(sessionDir, FEEDBACK_FILE), 'utf8');
  } catch (error) {
    if (isMissing(error)) return { events: [], nextLine: 0, malformed: 0 };
    throw error;
  }

  // The tail after the last '\n' is either '' (every line complete) or a
  // partial line — dropped either way, and not counted in nextLine.
  const lines = raw.split('\n');
  lines.pop();

  const events: FeedbackEvent[] = [];
  let malformed = 0;
  for (const line of lines.slice(afterLine)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    // Permissive by design (D2): anything with a string `type` passes through
    // with its unknown fields intact.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed += 1;
      continue;
    }
    const event = parsed as FeedbackEvent;
    if (typeof event.type !== 'string') {
      malformed += 1;
      continue;
    }
    events.push(event);
  }
  return { events, nextLine: lines.length, malformed };
}

/**
 * Resolves as soon as at least one event exists past `afterLine`, or on timeout
 * / abort with whatever is there (often nothing) — never rejects for either.
 * Watching the session dir rather than the file survives both a log that
 * doesn't exist yet and writers that replace it by rename; the poll covers
 * filesystems where fs.watch doesn't fire.
 */
export async function waitForFeedback(
  sessionDir: string,
  options: { afterLine: number; timeoutMs: number; signal?: AbortSignal },
): Promise<FeedbackBatch> {
  const { afterLine, timeoutMs, signal } = options;
  const first = await readFeedback(sessionDir, { afterLine });
  if (first.events.length > 0 || signal?.aborted === true) return first;

  return new Promise<FeedbackBatch>((resolve) => {
    let settled = false;
    let reading = false;
    let again = false;
    let final = false;
    let watcher: FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (batch: FeedbackBatch): void => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (poll !== undefined) clearInterval(poll);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(batch);
    };

    // fs.watch fires several times per append and the poll can land mid-read,
    // so overlapping reads collapse into one re-read.
    const check = (): void => {
      if (settled) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      readFeedback(sessionDir, { afterLine }).then(
        (batch) => {
          reading = false;
          if (settled) return;
          if (batch.events.length > 0 || final) finish(batch);
          else if (again) {
            again = false;
            check();
          }
        },
        () => {
          reading = false;
          if (settled) return;
          // A transient read failure: retry on the next nudge, unless this was
          // the last look.
          if (final) finish({ events: [], nextLine: afterLine, malformed: 0 });
          else if (again) {
            again = false;
            check();
          }
        },
      );
    };

    function onAbort(): void {
      final = true;
      check();
    }

    try {
      watcher = watch(sessionDir, () => check());
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // Session dir missing, or watching unsupported here — poll only.
    }
    poll = setInterval(check, POLL_MS);
    timer = setTimeout(onAbort, Math.max(0, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function idOf(event: FeedbackEvent, key: 'id' | 'thread'): string | null {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Folds the event stream into threads, in the order their comments opened.
 * Replies and resolves naming a thread this batch doesn't contain are dropped
 * silently — reading from a cursor mid-stream is the normal case, not an error.
 */
export function buildThreads(events: FeedbackEvent[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const event of events) {
    if (event.type === 'comment') {
      const id = idOf(event, 'id');
      // A repeated id keeps the thread it opened; a later comment can't rewrite
      // the root out from under the replies already attached to it.
      if (id === null || threads.has(id)) continue;
      threads.set(id, { id, root: event as CommentEvent, replies: [], resolved: false });
      continue;
    }
    if (event.type === 'reply') {
      const id = idOf(event, 'thread');
      if (id === null) continue;
      threads.get(id)?.replies.push(event as ReplyEvent);
      continue;
    }
    if (event.type === 'resolve') {
      const id = idOf(event, 'thread');
      const thread = id === null ? undefined : threads.get(id);
      if (thread === undefined) continue;
      // There is no un-resolve event (§6): resolved stays resolved, and the
      // last resolve names the author.
      thread.resolved = true;
      const by = (event as Record<string, unknown>).by;
      if (by === 'human' || by === 'agent') thread.resolvedBy = by;
      else delete thread.resolvedBy;
    }
  }
  return [...threads.values()];
}

/**
 * Counts the last verdict recorded per stop. An unrecognised verdict still
 * takes the stop's slot but lands in no bucket, so a future verdict kind is
 * never miscounted as one of these three.
 */
export function summarizeVerdicts(events: FeedbackEvent[]): ResultDoc['verdicts'] {
  const latest = new Map<string, unknown>();
  for (const event of events) {
    if (event.type !== 'verdict') continue;
    const stop = (event as Record<string, unknown>).stop;
    if (typeof stop !== 'string' || stop.length === 0) continue;
    latest.set(stop, (event as Record<string, unknown>).verdict);
  }
  const verdicts = { accepted: 0, needsWork: 0, questions: 0 };
  for (const verdict of latest.values()) {
    if (verdict === 'accepted') verdicts.accepted += 1;
    else if (verdict === 'needs-work') verdicts.needsWork += 1;
    else if (verdict === 'question') verdicts.questions += 1;
  }
  return verdicts;
}

/** Written via tmp + rename so the CLI's poll never reads a half-written result. */
export async function writeResult(sessionDir: string, result: ResultDoc): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
  const target = join(sessionDir, RESULT_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/** null when there is no result yet, or when what's there isn't a JSON object. */
export async function readResult(sessionDir: string): Promise<ResultDoc | null> {
  let raw: string;
  try {
    raw = await readFile(join(sessionDir, RESULT_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ResultDoc;
  } catch {
    return null;
  }
}

// `vsdiff pr` — GitHub PR mode (blueprint §3 pr mode, §7.5 D5): source a PR,
// publish the local conversation as one pending review, import replies back.
// Local files stay the authority; GitHub is a projection with receipts.

import {
  appendFeedback,
  computeDiff,
  loadConfig,
  loadSessionFile,
  readFeedback,
  resolveSession,
  buildThreads,
  type FeedbackEvent,
  type Thread,
} from '@vsdiff/core';
import { existsSync } from 'node:fs';
import {
  checkoutPr,
  prSessionSource,
  pullComments,
  publishReview,
  resolvePr,
  toFeedbackEvents,
  type PublishThread,
} from '@vsdiff/github';
import { readFile, writeFile } from 'node:fs/promises';
import { scaffoldSession, formatNewSummary } from './new-cmd.ts';

const ATTRIBUTION_FOOTER = '\n\n—\n_Reviewed with vsdiff — guided code review in VS Code._';

export interface PrStartResult {
  summary: string;
  sessionPath: string;
}

/** `vsdiff pr <n>`: resolve, checkout, scaffold a SHA-pinned session. */
export async function prStart(repoRoot: string, prNumber: number): Promise<PrStartResult> {
  const pr = await resolvePr(repoRoot, prNumber);
  if (pr.state !== 'OPEN') {
    process.stderr.write(`note: PR #${prNumber} is ${pr.state}\n`);
  }
  await checkoutPr(repoRoot, prNumber);
  const scaffold = await scaffoldSession({
    repoRoot,
    source: prSessionSource(pr),
    title: pr.title,
  });
  // Pin the session to the PR (blueprint §6: publishing refuses when the head moved).
  const sessionPath = scaffold.payload.sessionPath;
  const raw = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
  raw['pr'] = { number: pr.number, headSha: pr.headSha, url: pr.url };
  await writeFile(sessionPath, `${JSON.stringify(raw, null, 2)}\n`);
  return { summary: formatNewSummary(scaffold), sessionPath };
}

interface SessionPrRef {
  number: number;
  headSha: string;
}

async function sessionPr(sessionDir: string): Promise<SessionPrRef> {
  const loaded = await loadSessionFile(`${sessionDir}/session.json`);
  if (!loaded.ok) throw new Error(`cannot read session: ${loaded.errors.join('; ')}`);
  const pr = loaded.session['pr'] as Partial<SessionPrRef> | undefined;
  if (!pr || typeof pr.number !== 'number' || typeof pr.headSha !== 'string') {
    throw new Error(
      'this session has no "pr" field — start GitHub mode with `vsdiff pr <number>`.',
    );
  }
  return { number: pr.number, headSha: pr.headSha };
}

/** Threads that have no posted receipt yet — the outbox. */
function unposted(events: FeedbackEvent[], threads: Thread[]): Thread[] {
  const posted = new Set(
    events
      .filter((event) => event.type === 'posted' && typeof event['thread'] === 'string')
      .map((event) => event['thread'] as string),
  );
  return threads.filter((thread) => !posted.has(thread.id) && thread.root.author === 'human');
}

export interface PrPublishOptions {
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  body?: string;
}

/** Proposal mode: the outbox is the TRIAGED draft set, not feedback threads. */
async function proposalThreads(
  repoRoot: string,
  sessionDir: string,
  events: FeedbackEvent[],
): Promise<{ threads: PublishThread[]; reviewBody: string }> {
  const loaded = await loadSessionFile(`${sessionDir}/session.json`);
  if (!loaded.ok) throw new Error(`cannot read session: ${loaded.errors.join('; ')}`);
  const diff = await computeDiff(repoRoot, loaded.session.source);
  const resolved = resolveSession(loaded.session, diff);

  // Last triage decision per stop wins; pending and dropped never post.
  const triage = new Map<string, { decision: string; body?: string }>();
  for (const event of events) {
    if (event.type !== 'triage' || typeof event['stop'] !== 'string') continue;
    const decision = event['decision'];
    if (typeof decision !== 'string') continue;
    triage.set(event['stop'] as string, {
      decision,
      ...(typeof event['body'] === 'string' ? { body: event['body'] as string } : {}),
    });
  }

  const threads: PublishThread[] = [];
  for (const stop of resolved.stops) {
    const kind = stop.stop.kind ?? 'walkthrough';
    if (kind !== 'finding' && kind !== 'question') continue;
    const decision = triage.get(stop.stop.id);
    if (!decision || decision.decision === 'drop') continue;
    const anchor = stop.hunks[0];
    if (!anchor) continue; // stale drafts can't be placed — they stay local
    threads.push({
      id: `draft-${stop.stop.id}`,
      path: anchor.file.path,
      line: anchor.hunk.newStart,
      side: 'RIGHT',
      body:
        decision.decision === 'edit' && decision.body !== undefined
          ? decision.body
          : `**${stop.stop.title ?? stop.stop.id}**\n\n${stop.stop.prose}`,
    });
  }

  const reviewPath = `${sessionDir}/review.md`;
  const reviewBody = existsSync(reviewPath) ? await readFile(reviewPath, 'utf8') : '';
  return { threads, reviewBody };
}

export async function prPublish(
  repoRoot: string,
  sessionDir: string,
  options: PrPublishOptions,
): Promise<{ posted: number; skipped: number; reviewUrl?: string }> {
  const pr = await sessionPr(sessionDir);
  const batch = await readFeedback(sessionDir);

  const loaded = await loadSessionFile(`${sessionDir}/session.json`);
  const isProposal = loaded.ok && loaded.session['intent'] === 'proposal';

  let publishThreads: PublishThread[];
  let bodyBase: string;
  if (isProposal) {
    const proposal = await proposalThreads(repoRoot, sessionDir, batch.events);
    // Receipts still gate reposts: drop drafts already carrying a posted event.
    const posted = new Set(
      batch.events
        .filter((e) => e.type === 'posted' && typeof e['thread'] === 'string')
        .map((e) => e['thread'] as string),
    );
    publishThreads = proposal.threads.filter((thread) => !posted.has(thread.id));
    bodyBase = options.body ?? proposal.reviewBody;
  } else {
    const threads = buildThreads(batch.events);
    const outbox = unposted(batch.events, threads);
    publishThreads = outbox.map((thread) => ({
      id: thread.id,
      path: thread.root.path,
      line: thread.root.line,
      side: thread.root.side === 'base' ? 'LEFT' : 'RIGHT',
      body:
        thread.root.body +
        thread.replies
          .filter((reply) => reply.author === 'agent')
          .map((reply) => `\n\n> **agent:** ${reply.body}`)
          .join(''),
    }));
    bodyBase = options.body ?? '';
  }

  const { config } = await loadConfig(repoRoot);
  const footer = config.github?.attribution === 'none' ? '' : ATTRIBUTION_FOOTER;
  const body = `${bodyBase}${footer}`;

  const result = await publishReview(repoRoot, {
    prNumber: pr.number,
    headSha: pr.headSha,
    event: options.event,
    body,
    threads: publishThreads,
  });

  // Receipts (D5): match markers on the PR to local thread ids.
  const remote = await pullComments(repoRoot, pr.number);
  const byMarker = new Map(remote.filter((c) => c.threadMarker).map((c) => [c.threadMarker, c]));
  for (const { id } of result.posted) {
    const match = byMarker.get(id);
    await appendFeedback(sessionDir, {
      type: 'posted',
      thread: id,
      remote: {
        ...(result.reviewId !== undefined ? { reviewId: result.reviewId } : {}),
        ...(match ? { commentId: match.remoteId, url: match.url } : {}),
      },
    });
  }

  return {
    posted: result.posted.length,
    skipped: result.skipped.length,
    ...(result.reviewUrl !== undefined ? { reviewUrl: result.reviewUrl } : {}),
  };
}

export async function prPull(repoRoot: string, sessionDir: string): Promise<{ imported: number }> {
  const pr = await sessionPr(sessionDir);
  const batch = await readFeedback(sessionDir);
  const known = new Set<number>();
  for (const event of batch.events) {
    // Receipts carry remote.commentId; imported events carry remote.id.
    const remote = event['remote'] as { commentId?: number; id?: number } | undefined;
    if (remote?.commentId !== undefined) known.add(remote.commentId);
    if (remote?.id !== undefined) known.add(remote.id);
  }
  const remote = await pullComments(repoRoot, pr.number);
  const events = toFeedbackEvents(remote, known);
  for (const event of events) {
    await appendFeedback(sessionDir, event);
  }
  return { imported: events.length };
}

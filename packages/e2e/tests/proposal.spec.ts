import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  FIXTURE_L,
  exec,
  fetchState,
  openWorkbench,
  shot,
  waitForBridge,
  type BridgeInfo,
} from './helpers.ts';

// P5 / R13: proposal mode. The agent drafted a review of someone else's change;
// the human triages every draft comment before anything posts. This spec writes
// its own `intent: "proposal"` session into the L fixture (newer mtime, so the
// controller prefers it over the golden walkthrough session) and removes it
// again in afterAll — the other specs assert against the golden session.

const PROPOSAL_DIR = join(FIXTURE_L, '.vsdiff', 'sessions', '2026-01-03-proposal-draft');
const REVIEW_MD = join(PROPOSAL_DIR, 'review.md');

const REVIEW_BODY = `## Capture rework — first pass

Read the retry guard finding first; the rest is small. Happy to pair on the
idempotency question if it is easier than a thread.
`;

const EDITED_BODY =
  'The docs still describe two-phase capture — worth a follow-up PR, not a blocker.';

// Typed into the comment's own editor, one line: Enter is a newline there, but
// keeping it single-line means no keybinding can be mistaken for submit.
const INLINE_BODY = 'Inline edit: re-check the idempotency key before the retry charges again.';

const SESSION = {
  version: 1,
  kind: 'review',
  title: 'Draft review: payments refactor',
  focus: 'Drafted by an agent; every inline comment needs triage before it posts.',
  intent: 'proposal',
  source: { type: 'range', base: 'main', head: 'HEAD' },
  chapters: [
    {
      id: 'drafts',
      title: 'Draft comments',
      blurb: 'Accept, edit, or drop each one.',
      stops: [
        {
          id: 'capture-guard',
          kind: 'finding',
          severity: 'major',
          title: 'Double-charge guard lost on retry',
          prose:
            'The retry path re-enters `capture` without re-checking `idempotencyKey`; a timeout can charge twice.',
          hunkIds: ['src/payments/capture.ts:h1'],
        },
        {
          id: 'docs-drift',
          kind: 'finding',
          severity: 'minor',
          title: 'Docs lag the new flow',
          prose: '`docs/payments.md` still documents the old two-phase capture.',
          hunkIds: ['docs/payments.md:h1'],
        },
        {
          id: 'webhook-shape',
          kind: 'question',
          title: 'Is the webhook surface in scope?',
          prose: 'The handlers are stubs — is this file meant to land in this PR at all?',
          hunkIds: ['src/api/webhooks.ts:h1'],
        },
        {
          id: 'token-rename',
          kind: 'walkthrough',
          title: 'Token module rename',
          prose: 'Context only: the loader signature widened, call sites moved mechanically.',
          hunkIds: ['src/auth/tokens.ts:h1'],
        },
      ],
    },
  ],
};

interface ProposalShape {
  active: boolean;
  threads: number;
  pending: number;
  accepted: number;
  edited: number;
  dropped: number;
  /** Stop whose comment is open in the inline editor, null when none is. */
  editing: string | null;
}

interface ProposalState {
  proposal: ProposalShape;
  session: { phase: string; title?: string; stops?: number };
}

async function pollProposal(
  bridge: BridgeInfo,
  predicate: (state: ProposalState) => boolean,
  timeoutMs = 30_000,
): Promise<ProposalState> {
  const deadline = Date.now() + timeoutMs;
  let state = (await fetchState(bridge)) as unknown as ProposalState;
  while (Date.now() < deadline) {
    if (state.proposal && predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 400));
    state = (await fetchState(bridge)) as unknown as ProposalState;
  }
  throw new Error(`proposal state never matched: ${JSON.stringify(state)}`);
}

test.beforeAll(() => {
  mkdirSync(PROPOSAL_DIR, { recursive: true });
  writeFileSync(join(PROPOSAL_DIR, 'session.json'), `${JSON.stringify(SESSION, null, 2)}\n`);
  writeFileSync(REVIEW_MD, REVIEW_BODY);
  rmSync(join(PROPOSAL_DIR, 'feedback.jsonl'), { force: true });
});

test.afterAll(async () => {
  // The golden walkthrough session must be the newest one again for every other
  // spec (and the next run of this suite).
  rmSync(PROPOSAL_DIR, { recursive: true, force: true });
  try {
    const bridge = await waitForBridge(FIXTURE_L, 10_000);
    await exec(bridge, 'vsdiff.reload');
  } catch {
    // The extension host may already be gone — the deletion is what matters.
  }
});

test('P5: draft review triage — accept, edit, drop, and the posted payload', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');

  // Three draftable stops (finding|question); the walkthrough stop is narrative.
  const loaded = await pollProposal(
    bridge,
    (state) =>
      state.session.title === 'Draft review: payments refactor' &&
      state.proposal.active &&
      state.proposal.threads === 3,
  );
  expect(loaded.session.stops).toBe(4);
  expect(loaded.proposal).toMatchObject({ pending: 3, accepted: 0, edited: 0, dropped: 0 });

  // The drafts render as comment threads over the diff, visibly un-posted.
  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('vsdiff · draft (pending triage)').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('draft · pending').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('40-proposal-drafts.png') });

  // Triage (the string form of each command is the bridge/agent path; the UI
  // path passes the CommentThread from the thread-title menu).
  await exec(bridge, 'vsdiff.draft.accept', ['capture-guard']);
  await exec(bridge, 'vsdiff.draft.edit', ['docs-drift', EDITED_BODY]);
  await exec(bridge, 'vsdiff.draft.drop', ['webhook-shape']);

  const triaged = await pollProposal(bridge, (state) => state.proposal.pending === 0);
  expect(triaged.proposal).toMatchObject({ accepted: 1, edited: 1, dropped: 1, pending: 0 });

  // The tally lands in the status bar, and triaged drafts fold away…
  await expect(page.getByText('✓1 ✎1 ✗1 ?0').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('draft · pending')).toHaveCount(0, { timeout: 15_000 });
  // …carrying their decision when reopened.
  await exec(bridge, 'workbench.action.expandAllComments');
  await expect(page.getByText('draft · accepted').first()).toBeVisible({ timeout: 15_000 });
  // "accepted" is a label chip now (an <img>), so only its trailer is text.
  await expect(page.getByText('posts as written').first()).toBeVisible({
    timeout: 15_000,
  });
  // The Comments panel opens itself over the diff; close it so the shot shows
  // the draft thread rather than the index of it.
  await exec(bridge, 'workbench.action.closePanel');
  await page.screenshot({ path: shot('40-proposal-triage.png') });

  // Last decision per stop wins — a human is allowed to change their mind.
  await exec(bridge, 'vsdiff.draft.accept', ['webhook-shape']);
  await pollProposal(bridge, (state) => state.proposal.dropped === 0);
  await exec(bridge, 'vsdiff.draft.drop', ['webhook-shape']);
  await pollProposal(bridge, (state) => state.proposal.dropped === 1);

  // Exactly what the publisher would post: accepted as drafted, edited as
  // rewritten, dropped and untriaged absent, body straight off disk.
  const payload = (await exec(bridge, 'vsdiff.debug.proposalPayload')) as {
    body: string;
    threads: Array<{ stop: string; path: string; line: number; side: string; body: string }>;
  };
  expect(payload.body).toBe(readFileSync(REVIEW_MD, 'utf8'));
  expect(payload.threads).toHaveLength(2);
  const byStop = Object.fromEntries(payload.threads.map((thread) => [thread.stop, thread]));
  expect(byStop['capture-guard']).toEqual({
    id: 'draft-capture-guard',
    stop: 'capture-guard',
    path: 'src/payments/capture.ts',
    line: 24,
    side: 'RIGHT',
    body: `**Double-charge guard lost on retry**\n\n${SESSION.chapters[0]!.stops[0]!.prose}`,
  });
  expect(byStop['docs-drift']).toEqual({
    id: 'draft-docs-drift',
    stop: 'docs-drift',
    path: 'docs/payments.md',
    line: 50,
    side: 'RIGHT',
    body: EDITED_BODY,
  });
  expect(byStop['webhook-shape']).toBeUndefined();
  expect(byStop['token-rename']).toBeUndefined();

  // Triage is append-only feedback the agent can read back.
  const events = readFileSync(join(PROPOSAL_DIR, 'feedback.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; stop?: string; decision?: string });
  const triage = events.filter((event) => event.type === 'triage');
  expect(triage.map((event) => `${event.stop}:${event.decision}`)).toEqual([
    'capture-guard:accept',
    'docs-drift:edit',
    'webhook-shape:drop',
    'webhook-shape:accept',
    'webhook-shape:drop',
  ]);

  // The human's edit path: no body argument opens an input box prefilled with
  // the draft's prose, and what is submitted becomes what posts.
  const editing = exec(bridge, 'vsdiff.draft.edit', ['capture-guard']);
  const input = page.locator('.quick-input-widget input').first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue(SESSION.chapters[0]!.stops[0]!.prose);
  const typed = 'Re-check the idempotency key before the retry charges again.';
  await input.fill(typed);
  await input.press('Enter');
  expect(await editing).toEqual({ stop: 'capture-guard', decision: 'edit' });

  const reEdited = await pollProposal(bridge, (state) => state.proposal.edited === 2);
  expect(reEdited.proposal).toMatchObject({ accepted: 0, edited: 2, dropped: 1, pending: 0 });
  const after = (await exec(bridge, 'vsdiff.debug.proposalPayload')) as {
    threads: Array<{ stop: string; body: string }>;
  };
  expect(after.threads.find((thread) => thread.stop === 'capture-guard')?.body).toBe(typed);

  // The body is an ordinary file: open it, and scaffold it when it is missing.
  const opened = (await exec(bridge, 'vsdiff.openReviewBody')) as string;
  expect(opened.endsWith('review.md')).toBe(true);
  await expect(page.locator('.tab.active', { hasText: 'review.md' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: shot('41-proposal-review-body.png') });

  rmSync(REVIEW_MD, { force: true });
  await exec(bridge, 'vsdiff.openReviewBody');
  expect(existsSync(REVIEW_MD)).toBe(true);
  expect(readFileSync(REVIEW_MD, 'utf8')).toContain('vsdiff proposal mode');
});

// Round-4 dogfood: the overview renders the review body and edits it inline
// (write-through to review.md), and draft cards edit inline with live preview —
// no modal input box anywhere in the flow.
test('overview: review body + drafts render and edit inline', async ({ page }) => {
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');
  await pollProposal(bridge, (state) => state.proposal.active && state.proposal.threads === 3);

  await exec(bridge, 'vsdiff.openOverview');
  const frame = page.frameLocator('iframe.webview').last().frameLocator('#active-frame');
  await expect(frame.getByText('Review body').first()).toBeVisible({ timeout: 20_000 });
  // The prior test left review.md as scaffold-only; the scaffold comment is
  // authoring instructions, not body — so the empty state shows.
  await expect(frame.getByText('No review body yet').first()).toBeVisible({ timeout: 15_000 });

  // Write the body inline; Save writes through to review.md on disk.
  const BODY = 'Overall solid — one blocker inline, docs can follow up.';
  await frame.locator('[data-edit="#body"]').click();
  const bodyArea = frame.locator('.edit-area[data-key="#body"]');
  await expect(bodyArea).toBeVisible({ timeout: 10_000 });
  await bodyArea.fill(BODY);
  await expect(frame.locator('[data-preview="#body"]')).toContainText('Overall solid');
  await page.screenshot({ path: shot('74-overview-body-edit.png') });
  await frame.locator('[data-save="#body"]').click();
  const deadline = Date.now() + 15_000;
  let onDisk = '';
  while (Date.now() < deadline) {
    onDisk = existsSync(REVIEW_MD) ? readFileSync(REVIEW_MD, 'utf8') : '';
    if (onDisk === BODY) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(onDisk).toBe(BODY);
  await expect(frame.locator('.body-text')).toContainText('Overall solid', { timeout: 10_000 });

  // Draft cards: inline editor with live preview; Save is one triage event.
  const DRAFT = 'Scope check: are the webhook stubs meant to land here at all?';
  await frame.locator('[data-edit="webhook-shape"]').click();
  const draftArea = frame.locator('.edit-area[data-key="webhook-shape"]');
  await expect(draftArea).toBeVisible({ timeout: 10_000 });
  await draftArea.fill(DRAFT);
  await expect(frame.locator('[data-preview="webhook-shape"]')).toContainText('Scope check');
  await frame.locator('[data-save="webhook-shape"]').click();
  // capture-guard and docs-drift were already edited by the P5 test; this makes 3.
  await pollProposal(bridge, (state) => state.proposal.edited === 3);
  const payload = (await exec(bridge, 'vsdiff.debug.proposalPayload')) as {
    body: string;
    threads: Array<{ stop: string; body: string }>;
  };
  expect(payload.body).toBe(BODY);
  expect(payload.threads.find((thread) => thread.stop === 'webhook-shape')?.body).toBe(DRAFT);
  await page.screenshot({ path: shot('75-overview-proposal.png') });
});

function triageEvents(): Array<{ stop?: string; decision?: string; body?: string }> {
  const file = join(PROPOSAL_DIR, 'feedback.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; stop?: string; decision?: string })
    .filter((event) => event.type === 'triage');
}

// The edit path a human actually uses: the draft's own comment editor inside
// the thread (CommentMode.Editing), not a one-line modal. Every step is driven
// through the UI — the bridge only observes.
test('P5: draft edits happen inline in the comment, not in a modal', async ({ page }) => {
  // Start from untriaged drafts whatever the previous test left behind: pending
  // threads are the expanded ones, so the thread header is on screen.
  rmSync(join(PROPOSAL_DIR, 'feedback.jsonl'), { force: true });
  await openWorkbench(page, FIXTURE_L);
  const bridge = await waitForBridge(FIXTURE_L);
  await exec(bridge, 'vsdiff.reload');
  await pollProposal(
    bridge,
    (state) =>
      state.proposal.active && state.proposal.threads === 3 && state.proposal.pending === 3,
  );

  await exec(bridge, 'vsdiff.openStop', [0]);
  await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 20_000 });

  // Comment threads are zone widgets in the editor's own DOM (`.review-widget`),
  // not an iframe, so the whole flow is ordinary page interaction. Anchor on the
  // draft author, which survives the edit — the draft text is about to change,
  // and in proposal mode findings get no prose thread to be confused with.
  const widget = page.locator('.review-widget', { hasText: 'vsdiff · draft' }).first();
  await expect(widget).toBeVisible({ timeout: 20_000 });
  await expect(widget).toContainText('Double-charge guard lost on retry', { timeout: 20_000 });

  // Thread-title menu items render as monaco toolbar action items in the
  // widget header; they are addressed by the command title vsdiff contributes.
  // (UNCERTAIN: whether the tooltip lands on the <a class="action-label"> or on
  // its list item wrapper — matching either attribute covers both.)
  const editAction = widget.locator('[title*="Edit draft"], [aria-label*="Edit draft"]').first();
  await expect(editAction).toBeVisible({ timeout: 15_000 });
  await editAction.click();

  // The draft is now editable in place: a Monaco editor, prefilled with the
  // full draft (title line included — that is what posts on accept).
  const commentEditor = widget.locator('.edit-textarea .monaco-editor').first();
  await expect(commentEditor).toBeVisible({ timeout: 15_000 });
  await expect(commentEditor).toContainText('Double-charge guard lost on retry', {
    timeout: 15_000,
  });
  const editingState = await pollProposal(
    bridge,
    (state) => state.proposal.editing === 'capture-guard',
  );
  expect(editingState.proposal.pending).toBe(3); // nothing recorded by opening it

  await commentEditor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(INLINE_BODY);
  await expect(commentEditor).toContainText(INLINE_BODY, { timeout: 10_000 });
  // Proof the editor is open with the replacement text, before anything saves.
  await page.screenshot({ path: shot('73-inline-edit.png') });

  // Save is contributed at comments/comment/context, so it renders as a button
  // under the editor (the same place vscode-pull-request-github puts its own).
  // Matched by class + text: the accessible name may carry a keybinding hint.
  await widget.locator('.monaco-text-button', { hasText: 'Save' }).first().click();

  const saved = await pollProposal(
    bridge,
    (state) => state.proposal.editing === null && state.proposal.edited === 1,
  );
  expect(saved.proposal).toMatchObject({ pending: 2, accepted: 0, edited: 1, dropped: 0 });
  await expect(commentEditor).toBeHidden({ timeout: 15_000 });

  // What the human typed is the triage event, and the triage event is what posts.
  const triage = triageEvents().filter((event) => event.stop === 'capture-guard');
  expect(triage.at(-1)).toMatchObject({ decision: 'edit', body: INLINE_BODY });
  const payload = (await exec(bridge, 'vsdiff.debug.proposalPayload')) as {
    threads: Array<{ stop: string; body: string }>;
  };
  expect(payload.threads.find((thread) => thread.stop === 'capture-guard')?.body).toBe(INLINE_BODY);

  // Cancel closes the editor and records nothing (the thread folded away on
  // save, so reopen it first — same move the triage test makes).
  const before = triageEvents().length;
  await exec(bridge, 'workbench.action.expandAllComments');
  await exec(bridge, 'workbench.action.closePanel');
  await expect(editAction).toBeVisible({ timeout: 15_000 });
  await editAction.click();
  await expect(commentEditor).toBeVisible({ timeout: 15_000 });
  await pollProposal(bridge, (state) => state.proposal.editing === 'capture-guard');
  await widget.locator('.monaco-text-button', { hasText: 'Cancel' }).first().click();
  const cancelled = await pollProposal(bridge, (state) => state.proposal.editing === null);
  expect(cancelled.proposal.edited).toBe(1);
  expect(triageEvents()).toHaveLength(before);
});

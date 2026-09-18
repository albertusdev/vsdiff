import * as vscode from 'vscode';
import { chip, kindColor, STATE_COLOR } from './badges.ts';
import type { SessionController } from './controller.ts';
import type { FeedbackEvent, ResolvedSession, ResolvedStop } from './coreTypes.ts';
import { rightUriFor } from './uris.ts';

// Proposal mode (blueprint §3 "proposal", P5 / R13): the agent drafted a review
// of someone else's change and you decide what actually goes out under your
// name. Stops with kind finding|question ARE the draft inline comments;
// walkthrough/verify stops stay narrative and never post. The body is
// `review.md` beside session.json — an ordinary markdown file you edit
// directly, codiff plan-mode style: the saved file IS the final text.
//
// Triage state lives in feedback.jsonl as append-only `triage` events, so the
// agent reads back which of its drafts you kept, reworded, or threw away. Last
// event per stop wins — changing your mind is a normal move, not an edit.

const DRAFT_AUTHOR = 'vsdiff · draft (pending triage)';
const REVIEW_FILE = 'review.md';

const SCAFFOLD = `<!-- vsdiff proposal mode: this file is the review body that posts to GitHub
     under your account. Edit it directly — the saved file is the final text.
     The inline comments are the draft threads in the diff (Accept / Edit / Drop). -->

`;

export type TriageDecision = 'accept' | 'edit' | 'drop';

export interface TriageState {
  decision: TriageDecision;
  /** Present for 'edit': the human's replacement text, posted verbatim. */
  body?: string;
}

export interface ProposalTally {
  pending: number;
  accepted: number;
  edited: number;
  dropped: number;
}

/** One inline comment the publisher will post; mirrors the GitHub review shape. */
export interface ProposalThread {
  /** The CLI publisher's idempotency marker id (draft-<stop>). */
  id: string;
  stop: string;
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface ProposalPayload {
  body: string;
  threads: ProposalThread[];
}

const LABELS: Record<'pending' | TriageDecision, string> = {
  pending: 'draft · pending',
  accept: 'draft · accepted',
  edit: 'draft · edited',
  drop: 'dropped (will not post)',
};

const CONTEXT_SUFFIX: Record<'pending' | TriageDecision, string> = {
  pending: 'pending',
  accept: 'accepted',
  edit: 'edited',
  drop: 'dropped',
};

const EDITING_LABEL = 'draft · editing (unsaved)';

/** Only findings and questions are draft comments; the rest is narrative. */
export function isDraftable(stop: ResolvedStop): boolean {
  const kind = stop.stop.kind ?? 'walkthrough';
  return kind === 'finding' || kind === 'question';
}

/** The agent's draft as it would post: title in bold, then the prose. */
export function draftBody(stop: ResolvedStop): string {
  return `**${stop.stop.title ?? stop.stop.id}**\n\n${stop.stop.prose}`;
}

/** Last triage event per stop wins; unknown decisions are ignored, not guessed. */
export function foldTriage(events: readonly FeedbackEvent[]): Map<string, TriageState> {
  const triage = new Map<string, TriageState>();
  for (const event of events) {
    if (event.type !== 'triage' || typeof event['stop'] !== 'string') continue;
    const decision = event['decision'];
    if (decision !== 'accept' && decision !== 'edit' && decision !== 'drop') continue;
    const body = event['body'];
    triage.set(event['stop'] as string, {
      decision,
      ...(typeof body === 'string' ? { body } : {}),
    });
  }
  return triage;
}

/** Exactly what the publisher posts: accepted drafts as written, edited drafts
 *  as rewritten, nothing else. Dropped and untriaged drafts never leave. */
export function buildProposalPayload(
  resolved: ResolvedSession,
  triage: ReadonlyMap<string, TriageState>,
  reviewBody: string,
): ProposalPayload {
  const threads: ProposalThread[] = [];
  for (const stop of resolved.stops) {
    if (!isDraftable(stop)) continue;
    const state = triage.get(stop.stop.id);
    if (!state || state.decision === 'drop') continue;
    const anchor = stop.hunks[0];
    if (!anchor) continue; // stale draft: nowhere to anchor it, stays local
    threads.push({
      // `id` matches the CLI publisher's idempotency marker (draft-<stop>).
      id: `draft-${stop.stop.id}`,
      stop: stop.stop.id,
      path: anchor.file.path,
      line: anchor.hunk.newStart,
      side: 'RIGHT',
      body: state.decision === 'edit' && state.body !== undefined ? state.body : draftBody(stop),
    });
  }
  return { body: reviewBody, threads };
}

interface DraftThread extends vscode.CommentThread {
  vsdiffStop?: string;
}

/** The comment carries the stop id too: comment-level commands (Save, Cancel,
 *  the edit pencil) are handed the comment, never the thread. */
interface DraftComment extends vscode.Comment {
  vsdiffStop: string;
}

/** Menus and the bridge hand over whatever they hold: the thread (thread-title
 *  menu), the comment (comment menus), or a bare stop id (R18 parity path). */
type DraftTarget = vscode.CommentThread | vscode.Comment | string | undefined;

/** What the inline editor opens with: your own last wording when you are
 *  re-editing, otherwise the agent's full draft — title included, because that
 *  is what posts. */
export function editableDraft(stop: ResolvedStop, state: TriageState | undefined): string {
  return state?.decision === 'edit' && state.body !== undefined ? state.body : draftBody(stop);
}

/** VS Code replaces the comment's `body` with the editor's text before running
 *  the Save command, so the argument carries the new draft (GHPR reads it the
 *  same way, unwrapping MarkdownString defensively —
 *  vscode-pull-request-github/src/view/reviewCommentController.ts:930). */
function editedText(target: DraftTarget): string | undefined {
  if (typeof target === 'string' || !target) return undefined;
  // `text` is the editor's content on the raw marshalled argument, for the case
  // where the platform could not revive it into the comment we handed it.
  const candidate = target as { body?: unknown; text?: unknown };
  const body = candidate.body ?? candidate.text;
  if (typeof body === 'string') return body;
  const value = (body as vscode.MarkdownString | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
}

export class ProposalLayer implements vscode.Disposable {
  private readonly commentController: vscode.CommentController;
  private readonly threads = new Map<string, DraftThread>();
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private lastIdentity = '';
  /** Stop whose comment is open in the inline editor, if any. */
  private editing: string | undefined;

  constructor(private readonly controller: SessionController) {
    // A controller of its own (id `vsdiff-draft`): VS Code keys registered
    // controllers by `<id>-<extensionId>`, so a second controller sharing the
    // conversation layer's `vsdiff` id would evict it from the comment service.
    this.commentController = vscode.comments.createCommentController(
      'vsdiff-draft',
      'vsdiff draft review',
    );
    this.disposables.push(
      this.commentController,
      controller.onDidChange(() => {
        // Cursor moves fire the same event; only a new session rebuilds.
        if (this.identity() !== this.lastIdentity) void this.rebuild();
      }),
      controller.onDidChangeFeedback(() => this.repaint()),
    );
    void this.rebuild();
  }

  isActive(): boolean {
    const state = this.controller.getState();
    return state.phase === 'loaded' && state.resolved.session.intent === 'proposal';
  }

  private identity(): string {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return state.phase;
    const { resolved } = state;
    return [
      state.sessionPath,
      resolved.diff.headSha ?? '',
      resolved.stops.length,
      resolved.session.intent ?? 'walkthrough',
    ].join(':');
  }

  private triage(): Map<string, TriageState> {
    return foldTriage(this.controller.getFeedback().events);
  }

  // ---------------------------------------------------------------- threads

  private async rebuild(): Promise<void> {
    const generation = ++this.generation;
    this.lastIdentity = this.identity();
    // The session changed under the editor: the threads (and with them any
    // half-typed edit) are gone, so the editing flag has to go too.
    this.editing = undefined;
    this.disposeThreads();

    const state = this.controller.getState();
    if (state.phase !== 'loaded' || !this.isActive()) return;
    const { resolved } = state;

    for (const stop of resolved.stops) {
      if (!isDraftable(stop)) continue;
      const anchor = stop.hunks[0];
      if (!anchor) continue; // stale draft: visible in the outline, not postable
      const uri = await rightUriFor(resolved.diff, anchor.file);
      if (generation !== this.generation) return; // superseded mid-flight
      const line = Math.max(anchor.hunk.newStart - 1, 0);
      const thread = this.commentController.createCommentThread(
        uri,
        new vscode.Range(line, 0, line, 0),
        [],
      ) as DraftThread;
      thread.vsdiffStop = stop.stop.id;
      this.threads.set(stop.stop.id, thread);
    }
    this.repaint();
  }

  private repaint(): void {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    const triage = this.triage();
    for (const stop of state.resolved.stops) {
      const thread = this.threads.get(stop.stop.id);
      if (thread) this.paint(thread, stop, triage.get(stop.stop.id));
    }
  }

  private paint(thread: DraftThread, stop: ResolvedStop, state: TriageState | undefined): void {
    // Repaints fire on every feedback change; mid-edit the textarea holds
    // unsaved text that reassigning `comments` would throw away. Save and
    // cancel repaint this thread themselves.
    if (this.editing === stop.stop.id) return;
    const key = state?.decision ?? 'pending';
    const comment: DraftComment = {
      author: { name: DRAFT_AUTHOR },
      body: new vscode.MarkdownString(this.commentBody(stop, state)),
      mode: vscode.CommentMode.Preview,
      contextValue: 'vsdiff-draft-preview',
      vsdiffStop: stop.stop.id,
    };
    thread.comments = [comment];
    thread.label = LABELS[key];
    thread.contextValue = `vsdiff-draft-${CONTEXT_SUFFIX[key]}`;
    // Untriaged drafts demand a decision; triaged ones fold away.
    thread.collapsibleState = state
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    (thread as { state?: vscode.CommentThreadState }).state = state
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    // Edits go through the Edit command so every change is one triage event.
    thread.canReply = false;
  }

  private commentBody(stop: ResolvedStop, state: TriageState | undefined): string {
    const header = `${chip('draft', STATE_COLOR.neutral)} ${chip(
      stop.stop.kind ?? 'walkthrough',
      kindColor(stop.stop.kind, stop.stop.severity),
    )}`;
    const draft = `${header}\n\n${draftBody(stop)}`;
    switch (state?.decision) {
      case 'accept':
        return `${draft}\n\n${chip('accepted', STATE_COLOR.accepted)} _posts as written._`;
      case 'edit':
        return `${draft}\n\n---\n\n${chip('edited', STATE_COLOR.edited)} _this is what posts:_\n\n${state.body ?? ''}`;
      case 'drop':
        return `${draft}\n\n${chip('dropped', STATE_COLOR.dropped)} _stays on this machine._`;
      default:
        return `${draft}\n\n${chip('pending triage', STATE_COLOR.pending)} _accept, edit, or drop before posting._`;
    }
  }

  private disposeThreads(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
  }

  // ---------------------------------------------------------------- triage

  /** Thread-title menus hand over the CommentThread, comment menus the
   *  vscode.Comment; the bridge/e2e path (R18) passes the stop id directly. */
  private stopIdOf(target: DraftTarget): string | undefined {
    if (typeof target === 'string') return target || undefined;
    const stop = (target as DraftThread | DraftComment | undefined)?.vsdiffStop;
    return typeof stop === 'string' ? stop : undefined;
  }

  private stopOf(stopId: string): ResolvedStop | undefined {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return undefined;
    return state.resolved.stops.find((candidate) => candidate.stop.id === stopId);
  }

  private repaintStop(stopId: string): void {
    const thread = this.threads.get(stopId);
    const stop = this.stopOf(stopId);
    if (thread && stop) this.paint(thread, stop, this.triage().get(stopId));
  }

  async decide(
    target: vscode.CommentThread | string | undefined,
    decision: 'accept' | 'drop',
  ): Promise<{ stop: string; decision: TriageDecision } | undefined> {
    const stop = this.stopIdOf(target);
    if (!stop) return undefined;
    await this.controller.appendEvent({ type: 'triage', stop, decision });
    return { stop, decision };
  }

  /** Edit the draft's text. From a thread or comment with no body this opens
   *  the comment's own editor in place; `body` records the triage event
   *  straight away (bridge/e2e path); a bare stop id with no body falls back to
   *  the one-line input box (command palette, no widget to edit in). */
  async edit(
    target: DraftTarget,
    body?: string,
  ): Promise<{ stop: string; decision?: TriageDecision; editing?: boolean } | undefined> {
    const stop = this.stopIdOf(target);
    if (!stop) return undefined;
    if (body === undefined && target !== undefined && typeof target !== 'string') {
      return this.startEdit(stop);
    }
    let text = body;
    if (text === undefined) {
      text = await vscode.window.showInputBox({
        title: 'Edit draft comment',
        prompt: 'This text posts to GitHub under your name. Submit empty to cancel.',
        value: this.editableBody(stop),
      });
    }
    if (text === undefined || text.trim() === '') return undefined;
    await this.controller.appendEvent({ type: 'triage', stop, decision: 'edit', body: text });
    return { stop, decision: 'edit' };
  }

  /** Open the draft in the comment's own editor — the native VS Code flow, as
   *  in vscode-pull-request-github/src/github/prComment.ts:123 (`startEdit`).
   *  The array has to be *reassigned*: mutating it in place is not observed. */
  private startEdit(stopId: string): { stop: string; editing: true } | undefined {
    const thread = this.threads.get(stopId);
    const stop = this.stopOf(stopId);
    if (!thread || !stop) return undefined;
    this.editing = stopId;
    const comment: DraftComment = {
      author: { name: DRAFT_AUTHOR },
      // A plain string, not MarkdownString: this is editor content, not render.
      body: editableDraft(stop, this.triage().get(stopId)),
      mode: vscode.CommentMode.Editing,
      contextValue: 'vsdiff-draft-editing',
      vsdiffStop: stopId,
    };
    thread.comments = [comment];
    thread.label = EDITING_LABEL;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return { stop: stopId, editing: true };
  }

  /** Save the inline editor. VS Code replaces the comment's body with the
   *  editor's text before running the command, so the argument carries the new
   *  draft; the bridge/e2e form is (stopId, body). */
  async saveEdit(
    target: DraftTarget,
    body?: string,
  ): Promise<{ stop: string; decision: TriageDecision } | undefined> {
    const stop = this.stopIdOf(target) ?? this.editing;
    if (!stop) return undefined;
    const text = body ?? editedText(target);
    if (text === undefined || text.trim() === '') {
      // An emptied editor is a cancel, not a decision to post nothing.
      this.cancelEdit(stop);
      return undefined;
    }
    // Append first: if the write fails the editor stays open, text intact.
    await this.controller.appendEvent({ type: 'triage', stop, decision: 'edit', body: text });
    if (this.editing === stop) this.editing = undefined;
    this.repaintStop(stop);
    return { stop, decision: 'edit' };
  }

  /** Close the inline editor, recording nothing. */
  cancelEdit(target: DraftTarget): { stop: string } | undefined {
    const stop = this.stopIdOf(target) ?? this.editing;
    if (!stop) return undefined;
    if (this.editing === stop) this.editing = undefined;
    this.repaintStop(stop);
    return { stop };
  }

  /** Prefill for the fallback input box: your own last wording if you are
   *  re-editing, otherwise the agent's prose (an input box is one line — the
   *  bold title would lose its blank line and glue itself to the text). */
  private editableBody(stopId: string): string {
    const existing = this.triage().get(stopId);
    if (existing?.decision === 'edit' && existing.body !== undefined) return existing.body;
    return this.stopOf(stopId)?.stop.prose ?? '';
  }

  // ------------------------------------------------------------ review body

  private reviewUri(): vscode.Uri | undefined {
    const dir = this.controller.getSessionDir();
    return dir ? vscode.Uri.joinPath(vscode.Uri.file(dir), REVIEW_FILE) : undefined;
  }

  /** Opens the draft review body, scaffolding it when the agent left none. */
  async openReviewBody(): Promise<string | undefined> {
    const uri = this.reviewUri();
    if (!uri) {
      void vscode.window.showWarningMessage('vsdiff: no review session loaded.');
      return undefined;
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(SCAFFOLD));
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return uri.fsPath;
  }

  /** Write-through from the overview's inline editor: the file stays the
   *  authority — the overview is just a different pen on the same page. */
  async writeReviewBody(text: string): Promise<void> {
    const uri = this.reviewUri();
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  }

  /** Read fresh from disk every time: the file on disk is the body, whether it
   *  was edited in this editor, another one, or by the agent. */
  async readReviewBody(): Promise<string> {
    const uri = this.reviewUri();
    if (!uri) return '';
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return '';
    }
  }

  /** What the publisher would post right now (R18 parity hook). */
  async payload(): Promise<ProposalPayload | undefined> {
    const state = this.controller.getState();
    if (state.phase !== 'loaded' || !this.isActive()) return undefined;
    return buildProposalPayload(state.resolved, this.triage(), await this.readReviewBody());
  }

  // ------------------------------------------------------------------ tally

  tally(): ProposalTally | undefined {
    const state = this.controller.getState();
    if (state.phase !== 'loaded' || !this.isActive()) return undefined;
    const triage = this.triage();
    const tally: ProposalTally = { pending: 0, accepted: 0, edited: 0, dropped: 0 };
    for (const stop of state.resolved.stops) {
      if (!isDraftable(stop)) continue;
      switch (triage.get(stop.stop.id)?.decision) {
        case 'accept':
          tally.accepted++;
          break;
        case 'edit':
          tally.edited++;
          break;
        case 'drop':
          tally.dropped++;
          break;
        default:
          tally.pending++;
      }
    }
    return tally;
  }

  /** Bridge/e2e snapshot. `editing` is the stop whose inline editor is open. */
  snapshot(): ProposalTally & { active: boolean; threads: number; editing: string | null } {
    const tally = this.tally() ?? { pending: 0, accepted: 0, edited: 0, dropped: 0 };
    return {
      active: this.isActive(),
      threads: this.threads.size,
      editing: this.editing ?? null,
      ...tally,
    };
  }

  dispose(): void {
    this.generation++;
    this.editing = undefined;
    this.disposeThreads();
    for (const d of this.disposables) d.dispose();
  }
}

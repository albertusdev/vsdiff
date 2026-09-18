import * as vscode from 'vscode';
import { stopChips } from './badges.ts';
import type { SessionController } from './controller.ts';
import type { CommentEvent, CoreApi, ReplyEvent, ResolvedStop, Thread } from './coreTypes.ts';
import { headUriFor, repoPathOf, rightUriFor } from './uris.ts';
import { guideSummary } from './guide-summary.ts';

// The conversation surface (blueprint §6, §7.2): one CommentController carries
// two thread kinds —
//   · prose threads: the agent's narrative pinned at the top of each
//     stop's hunks, per file, expanded for the current stop (the dogfood
//     ask: "prose over the diff" — guidance lives where the code is, and multi-hunk
//     stops get a note per section), with replies kept under that guide;
//   · feedback threads: GitHub-PR-style human↔agent comment threads, replayed
//     from feedback.jsonl and updated live as either side appends.

const PROSE_AUTHOR = 'vsdiff · agent guide';

function renderBody(body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(body);
  md.isTrusted = false;
  return md;
}

function toComment(author: string, body: string, ts?: string): vscode.Comment {
  const comment: vscode.Comment = {
    author: { name: author },
    body: renderBody(body),
    mode: vscode.CommentMode.Preview,
  };
  if (ts) (comment as { timestamp?: Date }).timestamp = new Date(ts);
  return comment;
}

interface VsdiffThread extends vscode.CommentThread {
  vsdiffId?: string;
  vsdiffStop?: string;
  vsdiffGuide?: vscode.Comment;
}

interface GuideComment extends vscode.Comment {
  vsdiffStop: string;
}

export class CommentsLayer implements vscode.Disposable {
  private readonly commentController: vscode.CommentController;
  private readonly proseThreads = new Map<string, VsdiffThread>();
  private readonly feedbackThreads = new Map<string, VsdiffThread>();
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private lastIdentity = '';
  private proseReady = false;
  private readonly expandedGuides = new Set<string>();

  constructor(
    private readonly controller: SessionController,
    private readonly core: () => CoreApi | undefined,
  ) {
    this.commentController = vscode.comments.createCommentController('vsdiff', 'vsdiff review');
    this.commentController.options = {
      placeHolder: 'Ask a question or leave feedback…',
      prompt: 'Comment for the agent',
    };
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
    this.disposables.push(
      this.commentController,
      // onDidChange fires for both session replacement and cursor moves; a
      // full thread rebuild is only right for the former.
      controller.onDidChange(() => {
        if (this.identity() === this.lastIdentity) {
          this.refreshProseCollapse();
        } else {
          void this.rebuildProse();
        }
      }),
      controller.onDidChangeFeedback(() => this.syncFeedbackThreads()),
    );
    void this.rebuildProse();
  }

  /** Any line of a changed file (head side, real or virtual) is commentable. */
  private commentingRanges(document: vscode.TextDocument): vscode.Range[] | undefined {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return undefined;
    const path = repoPathOf(document.uri, state.resolved.diff.repoRoot);
    if (!path) return undefined;
    return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
  }

  // ---------------------------------------------------------------- prose

  private identity(): string {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return state.phase;
    const { resolved } = state;
    return `${state.sessionPath}:${resolved.diff.headSha ?? ''}:${resolved.stops.length}`;
  }

  private async rebuildProse(): Promise<void> {
    const generation = ++this.generation;
    this.proseReady = false;
    this.lastIdentity = this.identity();
    this.disposeFeedbackThreads();
    for (const thread of this.proseThreads.values()) thread.dispose();
    this.proseThreads.clear();

    const state = this.controller.getState();
    if (state.phase !== 'loaded') {
      this.disposeFeedbackThreads();
      return;
    }
    const { resolved } = state;
    const total = resolved.stops.length;
    const proposal = resolved.session['intent'] === 'proposal';

    for (const stop of resolved.stops) {
      // In proposal mode, finding/question stops render as DRAFT threads
      // (ProposalLayer) — a prose thread too would duplicate the text in place.
      const kind = stop.stop.kind ?? 'walkthrough';
      if (proposal && (kind === 'finding' || kind === 'question')) continue;
      const firstHunkByFile = new Map<string, (typeof stop.hunks)[number]>();
      for (const ref of stop.hunks) {
        if (!firstHunkByFile.has(ref.file.path)) firstHunkByFile.set(ref.file.path, ref);
      }
      for (const [path, ref] of firstHunkByFile) {
        const uri = await rightUriFor(resolved.diff, ref.file);
        if (generation !== this.generation) return; // superseded mid-flight
        const line = Math.max(ref.hunk.newStart - 1, 0);
        const guide = this.proseComment(stop, total);
        const thread = this.commentController.createCommentThread(
          uri,
          new vscode.Range(line, 0, line, 0),
          [guide],
        ) as VsdiffThread;
        thread.vsdiffStop = stop.stop.id;
        thread.vsdiffGuide = guide;
        thread.canReply = true;
        thread.label = `Stop ${stop.index + 1}/${total} — ${stop.stop.title ?? stop.stop.id}`;
        thread.collapsibleState = this.proseCollapse(stop);
        (thread as { state?: vscode.CommentThreadState }).state =
          vscode.CommentThreadState.Resolved;
        this.proseThreads.set(`${stop.index}:${path}`, thread);
      }
    }
    this.refreshProseCollapse();
    this.proseReady = true;
    this.syncFeedbackThreads();
  }

  private proseComment(stop: ResolvedStop, total: number): GuideComment {
    const stale = stop.stale
      ? `\n\n⚠ ${stop.missingHunkIds.length} referenced hunk(s) no longer resolve — the diff moved under this stop.`
      : '';
    const header = stopChips(stop.stop.kind, stop.stop.severity, `stop ${stop.index + 1}/${total}`);
    const summary = guideSummary(stop.stop.prose);
    const expanded = this.expandedGuides.has(stop.stop.id);
    return {
      ...toComment(
        PROSE_AUTHOR,
        `${header}\n\n${summary && !expanded ? summary : stop.stop.prose}${stale}`,
      ),
      vsdiffStop: stop.stop.id,
      ...(summary
        ? { contextValue: expanded ? 'vsdiff-guide-expanded' : 'vsdiff-guide-compact' }
        : {}),
    };
  }

  setGuideExpanded(target: vscode.Comment | string, expanded: boolean): void {
    const id = typeof target === 'string' ? target : (target as GuideComment)?.vsdiffStop;
    const state = this.controller.getState();
    if (!id || state.phase !== 'loaded') return;
    const stop = state.resolved.stops.find((candidate) => candidate.stop.id === id);
    if (!stop) return;
    if (expanded) this.expandedGuides.add(id);
    else this.expandedGuides.delete(id);
    for (const thread of this.proseThreads.values()) {
      if (thread.vsdiffStop !== id) continue;
      const previous = thread.vsdiffGuide;
      thread.vsdiffGuide = this.proseComment(stop, state.resolved.stops.length);
      thread.comments = thread.comments.map((comment) =>
        comment === previous ? thread.vsdiffGuide! : comment,
      );
    }
  }

  private proseCollapse(stop: ResolvedStop): vscode.CommentThreadCollapsibleState {
    return stop.index === this.controller.getCurrentIndex()
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
  }

  /** Called on cursor moves: expand the current stop's notes, collapse the rest. */
  refreshProseCollapse(): void {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    for (const [key, thread] of this.proseThreads) {
      if (thread.vsdiffId) continue; // Conversation state owns its collapse state.
      const index = Number(key.split(':')[0]);
      const stop = state.resolved.stops[index];
      if (stop) thread.collapsibleState = this.proseCollapse(stop);
    }
  }

  // ------------------------------------------------------------- feedback

  private disposeFeedbackThreads(): void {
    for (const thread of this.feedbackThreads.values()) thread.dispose();
    this.feedbackThreads.clear();
  }

  private syncFeedbackThreads(): void {
    // Feedback can load while rightUriFor is still resolving guide anchors.
    // Wait so restored conversations attach to their guide, once, in place.
    if (!this.proseReady) return;
    const state = this.controller.getState();
    if (state.phase !== 'loaded') {
      this.disposeFeedbackThreads();
      return;
    }
    const { repoRoot } = state.resolved.diff;
    for (const thread of this.controller.getFeedback().threads) {
      const existing = this.feedbackThreads.get(thread.id);
      if (existing) {
        this.paint(existing, thread);
        continue;
      }
      const uri = this.uriForFeedback(thread.root, repoRoot);
      const line = Math.max(thread.root.line - 1, 0);
      const guide = [...this.proseThreads.values()].find(
        (candidate) =>
          !candidate.vsdiffId &&
          candidate.vsdiffStop === thread.root.stop &&
          repoPathOf(candidate.uri, repoRoot) === thread.root.path &&
          candidate.range?.start.line === line,
      );
      const created =
        guide ??
        (this.commentController.createCommentThread(
          uri,
          new vscode.Range(line, 0, line, 0),
          [],
        ) as VsdiffThread);
      created.vsdiffId = thread.id;
      this.paint(created, thread);
      this.feedbackThreads.set(thread.id, created);
    }
  }

  private uriForFeedback(root: CommentEvent, repoRoot: string): vscode.Uri {
    const state = this.controller.getState();
    if (state.phase === 'loaded' && state.resolved.diff.source.type !== 'working-tree') {
      return headUriFor(state.resolved.diff, root.path);
    }
    return vscode.Uri.joinPath(vscode.Uri.file(repoRoot), root.path);
  }

  private paint(target: VsdiffThread, source: Thread): void {
    target.comments = [
      ...(target.vsdiffGuide ? [target.vsdiffGuide] : []),
      toComment(source.root.author === 'agent' ? 'Agent' : 'You', source.root.body, source.root.ts),
      ...source.replies.map((reply: ReplyEvent) =>
        toComment(reply.author === 'agent' ? 'Agent' : 'You', reply.body, reply.ts),
      ),
    ];
    target.label = source.resolved ? `resolved by ${source.resolvedBy ?? 'agent'}` : 'open';
    target.contextValue = source.resolved ? 'vsdiff-resolved' : 'vsdiff-open';
    // Active conversations stay open on screen; resolved ones fold away.
    target.collapsibleState = source.resolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    (target as { state?: vscode.CommentThreadState }).state = source.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    target.canReply = true;
  }

  /** The reply box submit — both brand-new threads and replies land here. */
  async handleReply(reply?: vscode.CommentReply): Promise<void> {
    // Palette and editor-title actions have no reply object. Use VS Code's
    // native composer so focus, multiline entry, and Ctrl+Enter work alike.
    if (!reply?.thread) {
      if (!vscode.window.activeTextEditor) {
        await vscode.commands.executeCommand('vsdiff.openStop', this.controller.getCurrentIndex());
      }
      await vscode.commands.executeCommand('workbench.action.addComment');
      return;
    }
    if (!reply.text.trim()) return;
    const thread = reply.thread as VsdiffThread;
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;

    if (thread.vsdiffId) {
      await this.controller.appendEvent({
        type: 'reply',
        thread: thread.vsdiffId,
        body: reply.text,
        author: 'human',
      });
      return;
    }

    const path = repoPathOf(thread.uri, state.resolved.diff.repoRoot);
    if (!path) {
      void vscode.window.showErrorMessage(
        'vsdiff: cannot comment outside the reviewed repository.',
      );
      return;
    }
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 256).toString(16)}`;
    thread.vsdiffId = id;
    this.feedbackThreads.set(id, thread);
    const stop = thread.vsdiffStop ?? this.controller.getCurrent()?.stop.id;
    try {
      await this.controller.appendEvent({
        type: 'comment',
        id,
        path,
        line: (thread.range?.start.line ?? 0) + 1,
        side: 'head',
        ...(stop ? { stop } : {}),
        body: reply.text,
        author: 'human',
      });
    } catch (error) {
      // A failed save must not make the next attempt a reply to a missing root.
      delete thread.vsdiffId;
      this.feedbackThreads.delete(id);
      throw error;
    }
  }

  /** Programmatic comment creation — the e2e/debug path (R18 parity). */
  async debugComment(path: string, line: number, body: string): Promise<string> {
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 256).toString(16)}`;
    await this.controller.appendEvent({
      type: 'comment',
      id,
      path,
      line,
      side: 'head',
      body,
      author: 'human',
    });
    return id;
  }

  async resolveThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as VsdiffThread).vsdiffId;
    if (!id) return;
    await this.controller.appendEvent({ type: 'resolve', thread: id, by: 'human' });
  }

  threadCounts(): { prose: number; feedback: number; open: number } {
    const threads = this.controller.getFeedback().threads;
    return {
      prose: this.proseThreads.size,
      feedback: threads.length,
      open: threads.filter((t) => !t.resolved).length,
    };
  }

  dispose(): void {
    this.generation++;
    for (const thread of this.proseThreads.values()) thread.dispose();
    this.disposeFeedbackThreads();
    for (const d of this.disposables) d.dispose();
  }
}

import * as vscode from 'vscode';
import { hunkKey, type SessionController } from './controller.ts';
import { guideSummary } from './guide-summary.ts';
import type { ResolvedSession, ResolvedStop } from './coreTypes.ts';
import type { ProposalLayer } from './proposal.ts';

// The Review Overview (the dogfood "guided intro" ask): a vsdiff-OWNED webview
// that auto-opens once per session — the flexible landing surface the bounded
// tree can't be. Every section hyperlinks to the same navigation the sidebar
// drives, LOC renders green/red (impossible in native tree rows), stops and
// chapters carry done-checkmarks, and proposal sessions render exactly what
// would post (body + drafts with inline triage). Unlike agent-authored HTML
// guides, this surface contains ONLY vsdiff-generated markup with escaped
// session data — it runs in untrusted workspaces by design.

interface OverviewStop {
  id: string;
  index: number;
  title: string;
  kind: string;
  severity: string | null;
  stale: boolean;
  prose: string;
  summary: string | null;
  add: number;
  del: number;
  done: boolean;
  verdict: string | null;
  priority: 'must' | 'nice';
  draft: { state: 'pending' | 'accepted' | 'edited' | 'dropped'; body: string } | null;
}

interface OverviewState {
  pinned: boolean;
  intent: 'walkthrough' | 'proposal';
  title: string;
  focus: string;
  source: string;
  guide: { available: boolean; trusted: boolean };
  progress: { done: number; total: number; mustDone: number; mustTotal: number };
  chapters: Array<{
    id: string;
    title: string;
    blurb: string;
    add: number;
    del: number;
    stops: OverviewStop[];
  }>;
  support: Array<{
    id: string;
    reason: string;
    files: number;
    hunks: number;
    add: number;
    del: number;
  }>;
  uncovered: Array<{ path: string; hunks: number; add: number; del: number; viewed: boolean }>;
  reviewBody: string;
  tally: { accepted: number; edited: number; dropped: number; pending: number } | null;
  /** Formatted semantic-validation issues; empty on a clean session. */
  issues: string[];
  coverage: CoverageState;
}

/** Per-hunk review state across the WHOLE diff, positional per file (h1…hN).
 *  `targets[i]` is [stopIndex, ordinal] for owned hunks, null for unowned —
 *  unowned hunks jump via the file diff instead. */
interface CoverageFile {
  path: string;
  states: Array<'cold' | 'seen' | 'done'>;
  targets: Array<[number, number] | null>;
  add: number;
  del: number;
}

interface CoverageState {
  files: CoverageFile[];
  done: number;
  seen: number;
  total: number;
}

function locOf(
  stops: Array<{ hunks: Array<{ hunk: { additions: number; deletions: number } }> }>,
): {
  add: number;
  del: number;
} {
  let add = 0;
  let del = 0;
  for (const stop of stops) {
    for (const { hunk } of stop.hunks) {
      add += hunk.additions;
      del += hunk.deletions;
    }
  }
  return { add, del };
}

export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private autoOpenedFor = '';
  private readonly disposables: vscode.Disposable[] = [];

  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pinned = false;
  private moving = false;
  private placement: Promise<void> = Promise.resolve();

  constructor(
    private readonly controller: SessionController,
    private readonly extensionUri: vscode.Uri,
    private readonly proposal: ProposalLayer,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.disposables.push(
      controller.onDidChange(() => {
        this.maybeAutoOpen();
        void this.push();
      }),
      // Feedback events arrive per keystroke of review activity (seen marks on
      // every nav, checkbox ticks); the always-visible beside panel would
      // rebuild coverage on each one. Trailing debounce keeps it live enough.
      controller.onDidChangeFeedback(() => this.pushSoon()),
    );
  }

  private pushSoon(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), 120);
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Once per session identity — the codiff-style landing, never nagging. */
  private maybeAutoOpen(): void {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    if (this.autoOpenedFor === state.sessionPath) return;
    this.autoOpenedFor = state.sessionPath;
    this.open();
  }

  private layout(): 'beside' | 'tab' {
    const pinned = this.workspaceState.get<boolean>('overview.pinned');
    if (pinned !== undefined) return pinned ? 'beside' : 'tab';
    const value = vscode.workspace.getConfiguration('vsdiff').get<string>('overview.layout');
    return value === 'beside' ? 'beside' : 'tab';
  }

  open(): void {
    if (this.panel) {
      const panel = this.panel;
      let revealed = panel.visible;
      const revealListener = panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) revealed = true;
      });
      panel.reveal(undefined, false);
      void this.restorePin();
      void this.push();
      // A panel that survived a serve-web window swap (page refresh, e2e page
      // churn) keeps messaging both ways but reveal() silently fails to
      // activate its tab. Verify, and rebuild the panel when the tab never
      // surfaced — the shell re-renders from pushed state, so nothing is lost.
      setTimeout(() => {
        revealListener.dispose();
        // A successful reveal followed by navigation is intentional. Do not
        // recreate the overview over the diff the reviewer just opened.
        if (revealed || this.panel !== panel || panel.visible) return;
        try {
          panel.dispose();
        } catch {
          this.panel = undefined;
        }
        this.open();
      }, 300);
      return;
    }
    const state = this.controller.getState();
    const title = state.phase === 'loaded' ? state.resolved.session.title : 'Review Overview';
    const beside = this.layout() === 'beside';
    this.pinned = beside;
    this.panel = vscode.window.createWebviewPanel(
      'vsdiff.overview',
      `${title} · overview`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [this.extensionUri] },
    );
    if (beside) {
      // 'beside': the overview lives in its own LOCKED group so diffs can
      // never open on top of it — the tab-burying class of bugs (landmines
      // #13–15) stops mattering because the panel stays visible. ViewColumn.Two
      // does NOT split an empty editor area (found by the quality e2e), so the
      // split is made explicitly: move the fresh panel right, lock its group,
      // hand focus back to the main group where diffs live.
      this.placement = this.placePanel(true);
    }
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    // retainContextWhenHidden is false: the iframe dies when the tab hides, so
    // a re-revealed panel needs its state pushed again or it says "Loading…"
    // forever (found by the overview e2e burying the tab under a diff).
    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) {
        void this.restorePin();
        void this.push();
      }
    });
    this.panel.webview.onDidReceiveMessage((message: { command: string; args?: unknown[] }) =>
      this.dispatch(message),
    );
    this.panel.webview.html = shellHtml();
    void this.push();
  }

  private async placePanel(beside: boolean): Promise<void> {
    if (
      beside &&
      vscode.window.tabGroups.all.length === 1 &&
      !vscode.window.tabGroups.all[0]!.tabs.some(
        (tab) => tab.input instanceof vscode.TabInputTextDiff,
      )
    ) {
      // Give the main group a review diff before moving Overview. Welcome
      // or restored utility tabs do not count as an open review.
      const state = this.controller.getState();
      const current = this.controller.getCurrent();
      const stop = current?.hunks.length
        ? current
        : state.phase === 'loaded'
          ? state.resolved.stops.find((candidate) => candidate.hunks.length > 0)
          : undefined;
      if (stop) await vscode.commands.executeCommand('vsdiff.openStop', stop.index);
    }
    this.panel?.reveal(undefined, false);
    if (beside) {
      await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
      await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    } else {
      await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
      await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
    }
  }

  private async restorePin(): Promise<void> {
    await this.placement;
    if (!this.panel || !this.pinned || this.moving) return;
    // serve-web can retain the extension host while rebuilding the workbench
    // with just one editor group. Restore the remembered pin in that window.
    if (this.panel.viewColumn !== vscode.ViewColumn.One && vscode.window.tabGroups.all.length > 1)
      return;
    this.moving = true;
    try {
      await this.placePanel(true);
    } finally {
      this.moving = false;
    }
  }

  async togglePin(): Promise<void> {
    if (this.moving) return;
    this.moving = true;
    try {
      if (!this.panel) this.open();
      await this.placement;
      const pinned = !this.pinned;
      await this.placePanel(pinned);
      this.pinned = pinned;
      await this.workspaceState.update('overview.pinned', pinned);
      await this.push();
    } finally {
      this.moving = false;
    }
  }

  private dispatch(message: { command: string; args?: unknown[] }): void {
    const args = message.args ?? [];
    switch (message.command) {
      case 'togglePin':
        void this.togglePin();
        break;
      case 'focusReview':
        void vscode.commands.executeCommand('vsdiff.focusReview');
        break;
      case 'openStop':
        void vscode.commands.executeCommand('vsdiff.openStop', args[0], args[1] ?? 0);
        break;
      case 'openFile':
        void vscode.commands.executeCommand('vsdiff.openFileDiff', args[0]);
        break;
      case 'toggleDone':
        void this.controller.appendEvent({
          type: 'stop-done',
          stop: String(args[0]),
          done: Boolean(args[1]),
        });
        break;
      case 'toggleChapterDone': {
        const state = this.controller.getState();
        if (state.phase !== 'loaded') break;
        const chapter = state.resolved.chapters.find((c) => c.chapter.id === args[0]);
        if (!chapter) break;
        void (async () => {
          for (const stop of chapter.stops) {
            await this.controller.appendEvent({
              type: 'stop-done',
              stop: stop.stop.id,
              done: Boolean(args[1]),
            });
          }
        })();
        break;
      }
      case 'toggleViewed':
        void this.controller.appendEvent({
          type: 'viewed',
          path: String(args[0]),
          viewed: Boolean(args[1]),
        });
        break;
      case 'triage':
        // Reuses the ProposalLayer commands (string form = bridge/programmatic
        // path). Edits arrive WITH the replacement text from the inline editor
        // — never route them through the modal prompt.
        if (args[1] === 'edit') {
          void vscode.commands.executeCommand(
            'vsdiff.draft.edit',
            String(args[0]),
            String(args[2] ?? ''),
          );
        } else {
          void vscode.commands.executeCommand(
            args[1] === 'accept' ? 'vsdiff.draft.accept' : 'vsdiff.draft.drop',
            String(args[0]),
          );
        }
        break;
      case 'saveReviewBody':
        void (async () => {
          await this.proposal.writeReviewBody(String(args[0] ?? ''));
          await this.push();
        })();
        break;
      case 'openGuide':
        void vscode.commands.executeCommand('vsdiff.openGuide');
        break;
      case 'openReviewBody':
        void vscode.commands.executeCommand('vsdiff.openReviewBody');
        break;
      case 'ready':
        // The shell asks for state when its script boots. Pushes that raced a
        // (re)created iframe — reveal after the tab was buried, first open —
        // are dropped by the platform; the handshake makes delivery certain.
        void this.push();
        break;
    }
  }

  /** Push fresh state; the webview renders client-side (no flash, keeps scroll). */
  private async push(): Promise<void> {
    if (!this.panel) return;
    const state = this.controller.getState();
    if (state.phase !== 'loaded') {
      void this.panel.webview.postMessage({ type: 'state', state: null });
      return;
    }
    const proposal = state.resolved.session['intent'] === 'proposal';
    const reviewBody = proposal ? await this.proposal.readReviewBody() : '';
    if (!this.panel) return; // disposed while reading
    this.panel.title = `${state.resolved.session.title} · overview`;
    const issues = state.issues.map((issue) => `${issue.path}: ${issue.message}`);
    void this.panel.webview.postMessage({
      type: 'state',
      state: this.buildState(state.resolved, reviewBody, issues),
    });
  }

  /** Per-hunk review state over the whole diff — the heatmap's data. */
  private buildCoverage(resolved: ResolvedSession): CoverageState {
    const feedback = this.controller.getFeedback();
    const owner = new Map<string, [number, number]>();
    for (const stop of resolved.stops) {
      stop.hunks.forEach((ref, ordinal) => {
        const key = hunkKey(ref);
        if (!owner.has(key)) owner.set(key, [stop.index, ordinal]);
      });
    }
    const stopDone = (index: number, path: string): boolean => {
      const id = resolved.stops[index]?.stop.id;
      if (id === undefined) return false;
      return feedback.doneStops.has(id) || (feedback.doneFiles.get(id)?.has(path) ?? false);
    };
    const files: CoverageFile[] = [];
    let done = 0;
    let seen = 0;
    let total = 0;
    for (const file of resolved.diff.files) {
      const states: CoverageFile['states'] = [];
      const targets: CoverageFile['targets'] = [];
      file.hunks.forEach((_hunk, i) => {
        const key = `${file.path}:h${i + 1}`;
        const target = owner.get(key) ?? null;
        const isDone = target
          ? stopDone(target[0], file.path)
          : feedback.viewedPaths.has(file.path);
        const state = isDone ? 'done' : feedback.seenHunks.has(key) ? 'seen' : 'cold';
        states.push(state);
        targets.push(target);
        total += 1;
        if (state === 'done') done += 1;
        else if (state === 'seen') seen += 1;
      });
      files.push({ path: file.path, states, targets, add: file.additions, del: file.deletions });
    }
    // Coldest first: the card answers "what have I NOT looked at yet".
    const coldOf = (f: CoverageFile) => f.states.filter((s) => s === 'cold').length;
    files.sort((a, b) => coldOf(b) - coldOf(a) || a.path.localeCompare(b.path));
    return { files, done, seen, total };
  }

  snapshot(): { open: boolean; pinned: boolean; autoOpenedFor: string } {
    return { open: this.isOpen(), pinned: this.pinned, autoOpenedFor: this.autoOpenedFor };
  }

  private buildState(
    resolved: ResolvedSession,
    reviewBody: string,
    issues: string[],
  ): OverviewState {
    const feedback = this.controller.getFeedback();
    const session = resolved.session;
    const intent = session['intent'] === 'proposal' ? 'proposal' : 'walkthrough';

    const triage = new Map<string, { decision: string; body?: string }>();
    for (const event of feedback.events) {
      if (event.type !== 'triage' || typeof event['stop'] !== 'string') continue;
      if (typeof event['decision'] !== 'string') continue;
      triage.set(event['stop'] as string, {
        decision: event['decision'] as string,
        ...(typeof event['body'] === 'string' ? { body: event['body'] as string } : {}),
      });
    }

    const toStop = (stop: ResolvedStop): OverviewStop => {
      const kind = stop.stop.kind ?? 'walkthrough';
      const draftable = intent === 'proposal' && (kind === 'finding' || kind === 'question');
      const decision = triage.get(stop.stop.id);
      const { add, del } = locOf([stop]);
      return {
        id: stop.stop.id,
        index: stop.index,
        title: stop.stop.title ?? stop.stop.id,
        kind,
        severity: stop.stop.severity ?? null,
        stale: stop.stale,
        prose: stop.stop.prose,
        summary: guideSummary(stop.stop.prose),
        add,
        del,
        done: feedback.doneStops.has(stop.stop.id),
        verdict: feedback.verdicts.get(stop.stop.id) ?? null,
        priority: stop.priority,
        draft: draftable
          ? {
              // Triage decisions are verbs (accept|edit|drop); the card state
              // is the past tense — an unmapped cast here once shipped 'edit'
              // into CSS classes and tallies expecting 'edited'.
              state:
                decision?.decision === 'accept'
                  ? 'accepted'
                  : decision?.decision === 'edit'
                    ? 'edited'
                    : decision?.decision === 'drop'
                      ? 'dropped'
                      : 'pending',
              body:
                decision?.decision === 'edit' && decision.body !== undefined
                  ? decision.body
                  : `**${stop.stop.title ?? stop.stop.id}**\n\n${stop.stop.prose}`,
            }
          : null,
      };
    };

    const chapters = resolved.chapters.map((chapter) => ({
      id: chapter.chapter.id,
      title: chapter.chapter.title,
      blurb: chapter.chapter.blurb ?? '',
      ...locOf(chapter.stops),
      stops: chapter.stops.map(toStop),
    }));

    const tallyBase = { accepted: 0, edited: 0, dropped: 0, pending: 0 };
    for (const chapter of chapters) {
      for (const stop of chapter.stops) {
        if (!stop.draft) continue;
        if (stop.draft.state === 'accepted') tallyBase.accepted++;
        else if (stop.draft.state === 'edited') tallyBase.edited++;
        else if (stop.draft.state === 'dropped') tallyBase.dropped++;
        else tallyBase.pending++;
      }
    }

    const source = session.source;
    const total = resolved.stops.length;
    return {
      pinned: this.pinned,
      intent,
      title: session.title,
      focus: session['focus'] === undefined ? '' : String(session['focus']),
      source:
        source.type === 'range' ? `${source.base ?? '?'} → ${source.head ?? 'HEAD'}` : source.type,
      guide: {
        available: session['guide'] !== undefined,
        trusted: vscode.workspace.isTrusted,
      },
      progress: {
        done: resolved.stops.filter((stop) => feedback.doneStops.has(stop.stop.id)).length,
        total,
        mustDone: resolved.stops.filter(
          (stop) => stop.priority === 'must' && feedback.doneStops.has(stop.stop.id),
        ).length,
        mustTotal: resolved.stops.filter((stop) => stop.priority === 'must').length,
      },
      chapters,
      support: resolved.support.map((group) => ({
        id: group.id,
        reason: group.reason,
        files: new Set(group.hunks.map((h) => h.file.path)).size,
        hunks: group.hunks.length,
        add: group.hunks.reduce((n, h) => n + h.hunk.additions, 0),
        del: group.hunks.reduce((n, h) => n + h.hunk.deletions, 0),
      })),
      uncovered: resolved.uncovered.map((entry) => ({
        path: entry.file.path,
        hunks: entry.hunks.length,
        add: entry.hunks.reduce((n, h) => n + h.additions, 0),
        del: entry.hunks.reduce((n, h) => n + h.deletions, 0),
        viewed: feedback.viewedPaths.has(entry.file.path),
      })),
      reviewBody,
      tally: intent === 'proposal' ? tallyBase : null,
      issues,
      coverage: this.buildCoverage(resolved),
    };
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Static shell; all data arrives as state messages and renders client-side.
 *  Everything interpolated by the renderer is escaped — session data is data. */
function shellHtml(): string {
  return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 1.1rem 1.4rem 3rem;
         line-height: 1.5; font-size: 13px; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  h1 { font-size: 1.25rem; margin: 0 0 .15rem; }
  .review-toolbar { display: flex; flex-wrap: wrap; gap: .4rem; margin: .6rem 0; }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .prose-toggle { display: block; margin-top: .3rem; }
  .focus { opacity: .85; margin: 0 0 .4rem; max-width: 60ch; }
  .meta { opacity: .6; font-size: .85em; margin-bottom: 1rem; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); font-weight: 600; }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); font-weight: 600; }
  .progress { height: 5px; background: var(--vscode-editorWidget-border, #444); border-radius: 3px;
              overflow: hidden; margin: .5rem 0 1.2rem; }
  .progress > div { height: 100%; background: var(--vscode-charts-green, #2ea043); transition: width .2s; }
  .chapter { border: 1px solid var(--vscode-panel-border); border-radius: 8px;
             padding: .6rem .8rem .3rem; margin-bottom: .8rem; }
  .chapter-head { display: flex; align-items: baseline; gap: .55rem; flex-wrap: wrap; }
  .chapter-head h2 { font-size: 1rem; margin: 0; }
  .blurb { opacity: .7; font-size: .9em; }
  .stop { display: grid; grid-template-columns: 1.4rem 1fr; gap: .1rem .5rem;
          padding: .45rem 0 .35rem; border-top: 1px solid var(--vscode-panel-border); }
  .stop-line { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .stop-title { font-weight: 600; }
  .kind { font-size: .78em; opacity: .75; border: 1px solid var(--vscode-panel-border);
          border-radius: 8px; padding: 0 .45em; }
  .sev-minor { color: #c99a2c; } .sev-major, .sev-blocker { color: #e5534b; } .sev-info { color: #4c8ed9; }
  .nice { font-size: .75em; opacity: .7; border-radius: 8px; padding: 0 .5em;
          background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
  .tier-filter { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 5px;
                 overflow: hidden; font-size: .82em; cursor: pointer; vertical-align: 1px; }
  .tier-filter span { padding: .05rem .55rem; }
  .tier-filter .on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .stale { color: #c99a2c; font-size: .8em; }
  .done-check { accent-color: var(--vscode-charts-green, #2ea043); margin-top: .2rem; cursor: pointer; }
  .prose { grid-column: 2; opacity: .88; max-width: 68ch; }
  .prose code { background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 0 .3em; }
  .verdict { font-size: .78em; opacity: .8; }
  .section-title { font-size: .95rem; margin: 1.3rem 0 .4rem; opacity: .9; }
  .row { display: flex; gap: .5rem; align-items: baseline; padding: .18rem 0; flex-wrap: wrap; }
  .dim { opacity: .65; font-size: .9em; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: .6rem .8rem;
          margin: .5rem 0; }
  .draft-pending { border-left: 3px solid #c99a2c; }
  .draft-accepted { border-left: 3px solid var(--vscode-charts-green, #2ea043); }
  .draft-edited { border-left: 3px solid #4c8ed9; }
  .draft-dropped { border-left: 3px solid var(--vscode-panel-border); opacity: .55; }
  .draft-actions { display: flex; gap: .4rem; margin-top: .35rem; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: 0; border-radius: 4px; padding: .2rem .6rem; cursor: pointer; font-size: .85em; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .banner { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
            border-radius: 8px; padding: .5rem .8rem; margin-bottom: 1rem; display: flex; gap: .6rem;
            align-items: baseline; flex-wrap: wrap; }
  .banner.warn { border-color: #c99a2c; background: color-mix(in srgb, #c99a2c 9%, transparent); }
  .banner.warn code { background: transparent; border: 0; padding: 0; }
  .cov-card { margin: 0 0 1rem; padding-bottom: .6rem; }
  .cov-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; cursor: pointer; }
  .cov-head .chev { opacity: .6; }
  .cov-rows { margin-top: .5rem; max-height: 21rem; overflow-y: auto; }
  .cov-row { display: grid; grid-template-columns: minmax(10rem, 18rem) 1fr 4.2rem; gap: .6rem;
             align-items: center; padding: .12rem 0; font-size: .88em; }
  .cov-file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; }
  .cov-bar { display: flex; gap: 2px; height: 10px; cursor: pointer; }
  .cov-bar i { flex: 1; border-radius: 2px; background: var(--vscode-editorWidget-border, #555); min-width: 3px; }
  .cov-bar i.seen { background: var(--vscode-charts-blue, #4c8ed9); }
  .cov-bar i.done { background: var(--vscode-charts-green, #2ea043); }
  .cov-pct { text-align: right; opacity: .7; font-variant-numeric: tabular-nums; }
  .body-card { margin: 0 0 1rem; }
  .body-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .25rem; }
  .body-text p, .edit-preview p, .prose p { margin: .3rem 0; }
  .edit-area { width: 100%; box-sizing: border-box; min-height: 7rem; resize: vertical;
               background: var(--vscode-input-background); color: var(--vscode-input-foreground);
               border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
               padding: .45rem .55rem; font-family: var(--vscode-editor-font-family, monospace);
               font-size: .95em; line-height: 1.45; }
  .edit-actions { display: flex; gap: .4rem; margin-top: .4rem; align-items: baseline; }
  .edit-hint { opacity: .55; font-size: .82em; }
  .edit-preview { border-top: 1px dashed var(--vscode-panel-border); margin-top: .45rem;
                  padding-top: .35rem; opacity: .85; }
  .empty { opacity: .7; padding: 2rem 0; }
</style>
</head>
<body>
<div id="root" class="empty">Loading session…</div>
<script>
  const vscodeApi = acquireVsCodeApi();
  const send = (command, ...args) => vscodeApi.postMessage({ command, args });
  // In-progress inline edits are keyed '#body' (review body) or a stop id, and
  // persisted through vscode's webview state: the iframe DIES whenever another
  // tab covers this one, and a state re-push re-renders — both must not eat a
  // half-written edit.
  let editing = (vscodeApi.getState() || {}).editing || {};
  let covOpen = (vscodeApi.getState() || {}).covOpen || false;
  let mustsOnly = (vscodeApi.getState() || {}).mustsOnly || false;
  let expandedProse = (vscodeApi.getState() || {}).expandedProse || {};
  let current = null;
  const persist = () => vscodeApi.setState({ editing, covOpen, mustsOnly, expandedProse });
  const setEditing = (key, value) => {
    if (value === undefined) delete editing[key];
    else editing[key] = value;
    persist();
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Inline-markdown for prose: escape first, then backtick-code and **bold**.
  const md = (s) => esc(s)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  // Block form: blank lines become paragraphs, single breaks stay breaks.
  const mdBlock = (s) => String(s).trim()
    ? String(s).trim().split(/\\n{2,}/)
        .map((p) => '<p>' + md(p).replace(/\\n/g, '<br>') + '</p>').join('')
    : '';
  // The scaffold's leading HTML comment is authoring instructions, not body.
  const stripScaffold = (s) => String(s).replace(/^<!--[^]*?-->\\s*/, '');
  const loc = (a, d) => '<span class="add">+' + a + '</span> <span class="del">−' + d + '</span>';

  const editorHtml = (key, hint) =>
    '<textarea class="edit-area" data-key="' + esc(key) + '" spellcheck="false"></textarea>' +
    '<div class="edit-actions">' +
    '<button class="primary" data-save="' + esc(key) + '">Save</button>' +
    '<button data-cancel="' + esc(key) + '">Cancel</button>' +
    '<span class="edit-hint">' + hint + ' · markdown · live preview below</span></div>' +
    '<div class="edit-preview" data-preview="' + esc(key) + '"></div>';

  const initialText = (key) => {
    if (!current) return '';
    if (key === '#body') return stripScaffold(current.reviewBody);
    for (const c of current.chapters) {
      for (const st of c.stops) if (st.id === key && st.draft) return st.draft.body;
    }
    return '';
  };

  function render(s) {
    const root = document.getElementById('root');
    if (!s) { root.className = 'empty'; root.textContent = 'No review session loaded.'; return; }
    root.className = '';
    let h = '<h1>' + esc(s.title) + '</h1>';
    h += '<div class="review-toolbar"><button data-layout="focusReview" title="Hide workspace panels and show the review outline">Focus review</button>' +
         '<button data-layout="togglePin" aria-pressed="' + s.pinned + '">' + (s.pinned ? 'Unpin Overview' : 'Pin Overview') + '</button></div>';
    if (s.focus) h += '<p class="focus">' + md(s.focus) + '</p>';
    const hasNice = s.progress.mustTotal < s.progress.total;
    h += '<p class="meta">' + esc(s.source) + ' · ' +
         (hasNice
           ? 'musts ' + s.progress.mustDone + '/' + s.progress.mustTotal + ' · nice ' +
             (s.progress.done - s.progress.mustDone) + '/' + (s.progress.total - s.progress.mustTotal) + ' done'
           : s.progress.done + '/' + s.progress.total + ' stops done') +
         (s.tally ? ' · proposal: ✓' + s.tally.accepted + ' ✎' + s.tally.edited +
         ' ✗' + s.tally.dropped + ' ?' + s.tally.pending : '') +
         (hasNice
           ? ' <span class="tier-filter" data-tierfilter="1"><span class="' + (mustsOnly ? '' : 'on') + '">All</span><span class="' + (mustsOnly ? 'on' : '') + '">Musts only</span></span>'
           : '') +
         '</p>';
    h += '<div class="progress"><div style="width:' +
         (s.progress.total ? Math.round((100 * s.progress.done) / s.progress.total) : 0) + '%"></div></div>';

    if (s.issues.length) {
      const shown = s.issues.slice(0, 3).map(esc).join('<br>');
      h += '<div class="banner warn">⚠ ' + s.issues.length + ' validation issue' +
           (s.issues.length === 1 ? '' : 's') + ' in this session — ask the agent to re-run ' +
           '<code>vsdiff validate</code>.<br><span class="dim">' + shown +
           (s.issues.length > 3 ? '<br>…and ' + (s.issues.length - 3) + ' more' : '') +
           '</span></div>';
    }

    // Coverage heatmap: per-hunk review state over the WHOLE diff, coldest
    // files first — the every-line reviewer's "what have I not looked at".
    const cov = s.coverage;
    if (cov.total > 0) {
      const cold = cov.total - cov.done - cov.seen;
      h += '<div class="card cov-card"><div class="cov-head" data-covtoggle="1">' +
           '<strong>Coverage</strong><span class="dim">' + cov.done + ' of ' + cov.total +
           ' hunks done · ' + cov.seen + ' seen · ' + cold + ' cold</span>' +
           (cold > 0 ? '<a data-covjump="1">jump to coldest</a>' : '') +
           '<span class="chev">' + (covOpen ? '▾' : '▸') + '</span></div>';
      if (covOpen) {
        h += '<div class="cov-rows">';
        for (const f of cov.files) {
          const doneN = f.states.filter((x) => x === 'done').length;
          const base = f.path.split('/').pop() || f.path;
          h += '<div class="cov-row"><span class="cov-file" title="' + esc(f.path) + '">' +
               esc(base) + ' <span class="dim">' + esc(f.path.slice(0, f.path.length - base.length)) +
               '</span></span><div class="cov-bar">';
          if (f.states.length <= 24) {
            f.states.forEach((st, i) => {
              const t = f.targets[i];
              const jump = t ? t[0] + ',' + t[1] : 'file:' + f.path;
              h += '<i class="' + st + '" data-jump="' + esc(jump) + '" title="' +
                   esc(f.path) + ':h' + (i + 1) + ' · ' + st + '"></i>';
            });
          } else {
            // Too many hunks for segments: one proportional 3-part bar; click
            // jumps to the file's first cold hunk.
            const seenN = f.states.filter((x) => x === 'seen').length;
            const coldN = f.states.length - doneN - seenN;
            const firstCold = f.states.indexOf('cold');
            const t = firstCold >= 0 ? f.targets[firstCold] : null;
            const jump = firstCold < 0 ? '' : t ? t[0] + ',' + t[1] : 'file:' + f.path;
            if (doneN) h += '<i class="done" style="flex-grow:' + doneN + '"></i>';
            if (seenN) h += '<i class="seen" style="flex-grow:' + seenN + '"></i>';
            if (coldN) h += '<i data-jump="' + esc(jump) + '" style="flex-grow:' + coldN + '" title="' + coldN + ' cold hunks"></i>';
          }
          h += '</div><span class="cov-pct">' + doneN + '/' + f.states.length + '</span></div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }

    if (s.guide.available) {
      h += '<div class="banner">📖 This session ships an agent-authored HTML guide.' +
           (s.guide.trusted
             ? ' <a onclick="send(\\'openGuide\\')">Open the guide</a>'
             : ' <span class="dim">Trust this workspace (banner up top) to view it, then</span> <a onclick="send(\\'openGuide\\')">open it</a>.') +
           '</div>';
    }
    if (s.intent === 'proposal') {
      h += '<div class="card body-card"><div class="body-head"><strong>Review body</strong>' +
           '<span class="dim">posts under your name · review.md</span>' +
           (editing['#body'] === undefined ? '<button data-edit="#body">✎ Edit</button>' : '') +
           '<a onclick="send(\\'openReviewBody\\')">open in editor</a></div>';
      if (editing['#body'] !== undefined) {
        h += editorHtml('#body', 'saves to review.md');
      } else {
        const body = stripScaffold(s.reviewBody);
        h += body
          ? '<div class="body-text">' + mdBlock(body) + '</div>'
          : '<div class="dim">No review body yet — it posts alongside your inline comments. ✎ Edit to write one.</div>';
      }
      h += '</div>';
    }

    for (const c of s.chapters) {
      const visible = mustsOnly ? c.stops.filter((x) => x.priority === 'must') : c.stops;
      if (mustsOnly && visible.length === 0) continue;
      const allDone = c.stops.length > 0 && c.stops.every((x) => x.done);
      h += '<div class="chapter"><div class="chapter-head">' +
           '<input type="checkbox" class="done-check" ' + (allDone ? 'checked' : '') +
           ' onchange="send(\\'toggleChapterDone\\', \\'' + esc(c.id) + '\\', this.checked)" title="Mark chapter done">' +
           '<h2>' + esc(c.title) + '</h2>' +
           '<span class="dim">' + c.stops.length + ' stops</span> ' + loc(c.add, c.del) +
           (c.stops.length > 0 && c.stops.every((x) => x.priority === 'nice')
             ? ' <span class="nice" title="internal-facing / easily reversible — the blurb says why">nice · FYI</span>'
             : '') +
           (c.blurb ? ' <span class="blurb">' + md(c.blurb) + '</span>' : '') + '</div>';
      for (const st of visible) {
        h += '<div class="stop">' +
             '<input type="checkbox" class="done-check" ' + (st.done ? 'checked' : '') +
             ' onchange="send(\\'toggleDone\\', \\'' + esc(st.id) + '\\', this.checked)" title="Mark stop done">' +
             '<div class="stop-line">' +
             '<a class="stop-title" onclick="send(\\'openStop\\', ' + st.index + ')">' + esc(st.title) + '</a>' +
             '<span class="kind' + (st.severity ? ' sev-' + esc(st.severity) : '') + '">' +
             esc(st.kind) + (st.severity ? ' · ' + esc(st.severity) : '') + '</span>' +
             loc(st.add, st.del) +
             (st.priority === 'nice' ? '<span class="nice">nice</span>' : '') +
             (st.verdict ? '<span class="verdict">→ ' + esc(st.verdict) + '</span>' : '') +
             (st.stale ? '<span class="stale">⚠ stale</span>' : '') +
             '</div>';
        if (st.draft) {
          h += '<div class="prose card draft-' + st.draft.state + '">' +
               '<div class="dim">draft · ' + st.draft.state + '</div>';
          if (editing[st.id] !== undefined) {
            h += editorHtml(st.id, 'posts under your name');
          } else {
            h += '<div>' + mdBlock(st.draft.body) + '</div>' +
                 '<div class="draft-actions">' +
                 '<button class="primary" onclick="send(\\'triage\\', \\'' + esc(st.id) + '\\', \\'accept\\')">✓ Accept</button>' +
                 '<button data-edit="' + esc(st.id) + '">✎ Edit</button>' +
                 '<button onclick="send(\\'triage\\', \\'' + esc(st.id) + '\\', \\'drop\\')">✗ Drop</button>' +
                 '</div>';
          }
          h += '</div>';
        } else {
          const expanded = !!expandedProse[st.id];
          h += '<div class="prose">' + mdBlock(st.summary && !expanded ? st.summary : st.prose) +
               (st.summary ? '<button class="prose-toggle" data-prosetoggle="' + esc(st.id) + '" aria-expanded="' + expanded + '">' +
                 (expanded ? 'Show less' : 'Show full guide') + '</button>' : '') + '</div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }

    if (s.support.length) {
      h += '<div class="section-title">Support — off the main path</div>';
      for (const g of s.support) {
        h += '<div class="row"><span>' + esc(g.reason) + '</span><span class="dim">' +
             g.files + ' files · ' + g.hunks + ' hunks</span>' + loc(g.add, g.del) + '</div>';
      }
    }
    if (s.uncovered.length) {
      h += '<div class="section-title">Not covered by the session — ' + s.uncovered.length + ' files</div>';
      for (const u of s.uncovered) {
        h += '<div class="row"><input type="checkbox" class="done-check" ' + (u.viewed ? 'checked' : '') +
             ' onchange="send(\\'toggleViewed\\', \\'' + esc(u.path) + '\\', this.checked)" title="Mark viewed">' +
             '<a onclick="send(\\'openFile\\', \\'' + esc(u.path) + '\\')">' + esc(u.path) + '</a>' +
             '<span class="dim">' + u.hunks + ' hunks</span>' + loc(u.add, u.del) + '</div>';
      }
    }
    root.innerHTML = h;
    // Textarea content is set as a DOM value, never interpolated into HTML.
    for (const area of document.querySelectorAll('.edit-area')) {
      area.value = editing[area.dataset.key] || '';
      const preview = document.querySelector('[data-preview="' + CSS.escape(area.dataset.key) + '"]');
      if (preview) preview.innerHTML = mdBlock(area.value);
    }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest
      ? ev.target.closest('[data-edit],[data-save],[data-cancel],[data-covtoggle],[data-covjump],[data-jump],[data-tierfilter],[data-layout],[data-prosetoggle]') : null;
    if (!el) return;
    const d = el.dataset;
    if (d.layout !== undefined) {
      send(d.layout);
      return;
    }
    if (d.prosetoggle !== undefined) {
      expandedProse[d.prosetoggle] = !expandedProse[d.prosetoggle];
      persist();
      render(current);
      document.querySelector('[data-prosetoggle="' + CSS.escape(d.prosetoggle) + '"]')?.focus();
      return;
    }
    if (d.jump !== undefined) {
      if (d.jump.startsWith('file:')) send('openFile', d.jump.slice(5));
      else if (d.jump !== '') {
        const parts = d.jump.split(',');
        send('openStop', Number(parts[0]), Number(parts[1]));
      }
      ev.stopPropagation();
      return;
    }
    if (d.covjump !== undefined) {
      // First cold hunk in coldest-first order.
      if (current) {
        for (const f of current.coverage.files) {
          const i = f.states.indexOf('cold');
          if (i < 0) continue;
          const t = f.targets[i];
          if (t) send('openStop', t[0], t[1]);
          else send('openFile', f.path);
          break;
        }
      }
      ev.stopPropagation();
      return;
    }
    if (d.covtoggle !== undefined) {
      covOpen = !covOpen;
      persist();
      render(current);
      return;
    }
    if (d.tierfilter !== undefined) {
      mustsOnly = !mustsOnly;
      persist();
      render(current);
      return;
    }
    if (d.edit !== undefined) {
      setEditing(d.edit, editing[d.edit] !== undefined ? editing[d.edit] : initialText(d.edit));
      render(current);
      const area = document.querySelector('.edit-area[data-key="' + CSS.escape(d.edit) + '"]');
      if (area) area.focus();
    } else if (d.cancel !== undefined) {
      setEditing(d.cancel, undefined);
      render(current);
    } else if (d.save !== undefined) {
      const text = editing[d.save] !== undefined ? editing[d.save] : '';
      if (d.save !== '#body' && !text.trim()) return; // an empty draft can't post
      if (d.save === '#body') {
        if (current) current.reviewBody = text; // optimistic — the push confirms
        send('saveReviewBody', text);
      } else {
        if (current) {
          for (const c of current.chapters) {
            for (const st of c.stops) {
              if (st.id === d.save && st.draft) {
                st.draft.state = 'edited';
                st.draft.body = text;
              }
            }
          }
        }
        send('triage', d.save, 'edit', text);
      }
      setEditing(d.save, undefined);
      render(current);
    }
  });
  document.addEventListener('input', (ev) => {
    const area = ev.target;
    if (!area || !area.classList || !area.classList.contains('edit-area')) return;
    setEditing(area.dataset.key, area.value);
    const preview = document.querySelector('[data-preview="' + CSS.escape(area.dataset.key) + '"]');
    if (preview) preview.innerHTML = mdBlock(area.value);
  });

  window.send = send;
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      current = e.data.state;
      render(current);
    }
  });
  send('ready');
</script>
</body>
</html>`;
}

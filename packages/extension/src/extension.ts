import * as vscode from 'vscode';
import * as coreModule from '@vsdiff/core';
import { SCHEMA_VERSION } from '@vsdiff/schema';
import type { CoreApi } from './coreTypes.ts';
import { SessionController } from './controller.ts';
import { CommentsLayer } from './comments.ts';
import { OutlineDecorations } from './decorations.ts';
import { GuidePanel } from './guide.ts';
import { Navigator } from './navigation.ts';
import { OutlineProvider } from './outline.ts';
import { OverviewPanel } from './overview.ts';
import { ProposalLayer } from './proposal.ts';
import { ReadTracker } from './readTracker.ts';
import { StatusBar } from './status.ts';
import { GIT_SCHEME, GitFileSystemProvider } from './gitFs.ts';
import { leftUriFor, rightUriFor } from './uris.ts';
import { startBridge } from './bridge.ts';

// The core engine lands in parallel work streams; feature-detect so the
// extension degrades to an explicit "core pending" state instead of crashing.
function coreApi(): CoreApi | undefined {
  const candidate = coreModule as Partial<CoreApi>;
  if (
    typeof candidate.computeDiff === 'function' &&
    typeof candidate.resolveSession === 'function' &&
    typeof candidate.showFile === 'function' &&
    typeof candidate.appendFeedback === 'function' &&
    typeof candidate.buildThreads === 'function'
  ) {
    return candidate as CoreApi;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new SessionController(coreApi);
  const outline = new OutlineProvider(controller);
  const navigator = new Navigator(controller);
  const proposal = new ProposalLayer(controller);
  const status = new StatusBar(controller, navigator, () => proposal.tally());
  const comments = new CommentsLayer(controller, coreApi);
  const guide = new GuidePanel(controller, navigator);
  const overview = new OverviewPanel(
    controller,
    context.extensionUri,
    proposal,
    context.workspaceState,
  );
  const readTracker = new ReadTracker(controller);
  const outlineView = vscode.window.createTreeView('vsdiff.outline', {
    treeDataProvider: outline,
    manageCheckboxStateManually: true,
  });
  outlineView.onDidChangeCheckboxState((event) => {
    for (const [node, checkState] of event.items) {
      const checked = checkState === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'uncovered-file') {
        void controller.appendEvent({ type: 'viewed', path: node.path, viewed: checked });
      } else if (node.kind === 'stop') {
        void controller.appendEvent({ type: 'stop-done', stop: node.stop.stop.id, done: checked });
      } else if (node.kind === 'stop-file') {
        // Roll-up lives on the writer side (the feedback fold stays dumb): a
        // file tick that completes the set also marks the stop whole-done, and
        // unticking one file of a whole-done stop rewrites the rest as file
        // ticks — a plain stop-done:false clears the stop's file marks with it.
        const { stopId, path, siblings } = node;
        void (async () => {
          if (checked) {
            await controller.appendEvent({ type: 'stop-done', stop: stopId, path, done: true });
            const marked = controller.getFeedback().doneFiles.get(stopId) ?? new Set<string>();
            if (siblings.every((file) => marked.has(file))) {
              await controller.appendEvent({ type: 'stop-done', stop: stopId, done: true });
            }
          } else if (controller.getFeedback().doneStops.has(stopId)) {
            await controller.appendEvent({ type: 'stop-done', stop: stopId, done: false });
            for (const file of siblings) {
              if (file === path) continue;
              await controller.appendEvent({
                type: 'stop-done',
                stop: stopId,
                path: file,
                done: true,
              });
            }
          } else {
            await controller.appendEvent({ type: 'stop-done', stop: stopId, path, done: false });
          }
        })();
      } else if (node.kind === 'chapter') {
        void (async () => {
          for (const stop of node.stops) {
            await controller.appendEvent({
              type: 'stop-done',
              stop: stop.stop.id,
              done: checked,
            });
          }
        })();
      }
    }
  });

  context.subscriptions.push(
    controller,
    navigator,
    status,
    comments,
    proposal,
    guide,
    overview,
    readTracker,
    outlineView,
    vscode.workspace.registerFileSystemProvider(GIT_SCHEME, new GitFileSystemProvider(coreApi), {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.window.registerFileDecorationProvider(new OutlineDecorations()),
  );

  let focusedFor = '';
  controller.onDidChange(() => {
    const loaded = controller.getState();
    if (
      loaded.phase === 'loaded' &&
      vscode.env.uiKind === vscode.UIKind.Web &&
      focusedFor !== loaded.sessionPath
    ) {
      focusedFor = loaded.sessionPath;
      void vscode.commands.executeCommand('vsdiff.focusReview');
    }
    void vscode.commands.executeCommand(
      'setContext',
      'vsdiff.sessionLoaded',
      controller.getState().phase === 'loaded',
    );
    // The Overview auto-opens once per session (its guide card replaces the
    // old toast) — see OverviewPanel.maybeAutoOpen.
    void vscode.commands.executeCommand('setContext', 'vsdiff.proposal', proposal.isActive());
    // Availability is a disk check (the file can appear after the session does),
    // so the context key lands one tick behind the state change.
    void guide
      .refresh()
      .then((available) =>
        vscode.commands.executeCommand('setContext', 'vsdiff.hasGuide', available),
      );
    comments.refreshProseCollapse();
  });

  const command = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('vsdiff.hello', () => {
    const message = `vsdiff ${context.extension.packageJSON.version} — schema v${SCHEMA_VERSION}`;
    void vscode.window.showInformationMessage(message);
    return message;
  });

  command('vsdiff.reload', () => controller.reload());
  command('vsdiff.openOverview', async () => {
    // A stop updates the cursor before its diff has finished opening. Let
    // that navigation settle so it cannot cover a newly requested Overview.
    await navigator.whenIdle();
    overview.open();
  });
  command('vsdiff.toggleOverviewPin', () => overview.togglePin());
  command('vsdiff.focusReview', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.view.extension.vsdiff');
  });
  command('vsdiff.expandGuide', (target: vscode.Comment | string) =>
    comments.setGuideExpanded(target, true),
  );
  command('vsdiff.collapseGuide', (target: vscode.Comment | string) =>
    comments.setGuideExpanded(target, false),
  );
  command('vsdiff.openStop', (index: number = 0, hunkOrdinal: number = 0) =>
    navigator.openStop(index, hunkOrdinal),
  );
  // The universal walk: every hunk of every stop in session order (the
  // editor-title chevrons and ctrl+alt+j/k). Stop-level jumps stay below.
  command('vsdiff.next', () => navigator.next());
  command('vsdiff.prev', () => navigator.prev());
  command('vsdiff.nextStop', () => navigator.nextStop());
  command('vsdiff.prevStop', () => navigator.prevStop());
  command('vsdiff.nextHunk', () => navigator.nextHunk());
  command('vsdiff.prevHunk', () => navigator.prevHunk());

  command('vsdiff.pickStop', async () => {
    const state = controller.getState();
    if (state.phase !== 'loaded') return;
    const picks = state.resolved.stops.map((stop) => ({
      label: `$(${stop.stop.kind === 'finding' ? 'bug' : stop.stop.kind === 'question' ? 'question' : stop.stop.kind === 'verify' ? 'beaker' : 'book'}) ${stop.stop.title ?? stop.stop.id}`,
      description: `${stop.index + 1}/${state.resolved.stops.length}${stop.stale ? ' · ⚠ stale' : ''}`,
      detail: stop.stop.prose.length > 120 ? `${stop.stop.prose.slice(0, 117)}…` : stop.stop.prose,
      index: stop.index,
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Jump to a review stop',
    });
    if (picked) await navigator.openStop(picked.index);
  });

  command('vsdiff.openFileDiff', async (path: string) => {
    const state = controller.getState();
    if (state.phase !== 'loaded' || !path) return;
    const { diff } = state.resolved;
    const file = diff.files.find((f) => f.path === path);
    if (!file) return;
    const left = leftUriFor(diff, file);
    const right = await rightUriFor(diff, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (vsdiff)`);
  });

  // ---- P2: the conversation ------------------------------------------------
  command('vsdiff.addComment', (reply?: vscode.CommentReply) => comments.handleReply(reply));
  command('vsdiff.resolveThread', (thread: vscode.CommentThread) => comments.resolveThread(thread));

  const verdict = (value: 'accepted' | 'needs-work' | 'question') => async () => {
    const current = controller.getCurrent();
    if (!current) return;
    await controller.appendEvent({ type: 'verdict', stop: current.stop.id, verdict: value });
    void vscode.window.setStatusBarMessage(
      `vsdiff: "${current.stop.title ?? current.stop.id}" → ${value}`,
      3000,
    );
    return value;
  };
  // R18 parity for the tree/overview done-checkboxes.
  command('vsdiff.markStopDone', (stop: string, done: boolean = true) =>
    controller.appendEvent({ type: 'stop-done', stop: String(stop), done: Boolean(done) }),
  );

  command('vsdiff.verdict.accept', verdict('accepted'));
  command('vsdiff.verdict.needsWork', verdict('needs-work'));
  command('vsdiff.verdict.question', verdict('question'));

  command('vsdiff.finishReview', async (statusArg?: unknown) => {
    const api = coreApi();
    const dir = controller.getSessionDir();
    const state = controller.getState();
    if (!api || !dir || state.phase !== 'loaded') return;

    // View-title buttons invoke commands WITH an argument (a context object) —
    // anything that isn't one of the two literal statuses means "ask". Trusting
    // it raw once wrote `[object Object]` into result.json and the toast.
    let status: 'approved' | 'changes-requested' | undefined =
      statusArg === 'approved' || statusArg === 'changes-requested' ? statusArg : undefined;
    if (!status) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(check) Approve', value: 'approved' as const },
          { label: '$(request-changes) Request changes', value: 'changes-requested' as const },
        ],
        { placeHolder: 'Finish this review' },
      );
      if (!picked) return;
      status = picked.value;

      // Approving with unfinished MUST stops deserves a pause; unfinished nice
      // ones don't — that's the point of the tier. Interactive path only: an
      // explicit status argument is a programmatic caller (bridge, agent) and
      // must never block on a dialog.
      if (status === 'approved') {
        const openMusts = state.resolved.stops.filter(
          (stop) =>
            stop.priority === 'must' && !controller.getFeedback().doneStops.has(stop.stop.id),
        );
        if (openMusts.length > 0) {
          const proceed = await vscode.window.showWarningMessage(
            `${openMusts.length} must-review stop${openMusts.length === 1 ? '' : 's'} not checked off (e.g. "${openMusts[0]?.stop.title ?? openMusts[0]?.stop.id}"). Approve anyway?`,
            { modal: true },
            'Approve anyway',
          );
          if (proceed !== 'Approve anyway') return;
        }
      }
    }

    const feedback = controller.getFeedback();
    const result = {
      status,
      verdicts: api.summarizeVerdicts(feedback.events),
      verdictsByStop: Object.fromEntries(feedback.verdicts),
      openThreads: feedback.threads.filter((t) => !t.resolved).map((t) => t.id),
      resolvedThreads: feedback.threads.filter((t) => t.resolved).map((t) => t.id),
      finishedAt: new Date().toISOString(),
    };
    await api.writeResult(dir, result);
    await controller.appendEvent({ type: 'done', status });
    void vscode.window.showInformationMessage(
      `vsdiff: review finished — ${status} (${result.openThreads.length} open thread(s)).`,
    );
    return result;
  });

  command('vsdiff.applyCommitMessage', async () => {
    const state = controller.getState();
    if (state.phase !== 'loaded') return;
    const commit = state.resolved.session['commit'] as
      | { title?: string; body?: string }
      | undefined;
    if (!commit || typeof commit.title !== 'string') {
      void vscode.window.showInformationMessage('vsdiff: this session proposes no commit message.');
      return;
    }
    const gitExtension = vscode.extensions.getExtension<{
      getAPI(version: 1): { repositories: Array<{ inputBox: { value: string } }> };
    }>('vscode.git');
    const api = gitExtension?.isActive
      ? gitExtension.exports.getAPI(1)
      : (await gitExtension?.activate())?.getAPI(1);
    const repository = api?.repositories[0];
    if (!repository) {
      void vscode.window.showWarningMessage('vsdiff: no git repository open.');
      return;
    }
    repository.inputBox.value = commit.body ? `${commit.title}\n\n${commit.body}` : commit.title;
    void vscode.window.setStatusBarMessage('vsdiff: commit message applied to SCM input.', 3000);
    return repository.inputBox.value;
  });

  // ---- P5: proposal-mode triage --------------------------------------------
  // Thread-title menus pass the CommentThread; a leading string is the
  // bridge/agent form (`stopId`, plus the new body for edit) — R18 parity.
  command('vsdiff.draft.accept', (target: vscode.CommentThread | string) =>
    proposal.decide(target, 'accept'),
  );
  command('vsdiff.draft.drop', (target: vscode.CommentThread | string) =>
    proposal.decide(target, 'drop'),
  );
  // A thread or comment with no body opens the comment's own editor in place;
  // (stopId, body) records the triage event headlessly.
  command(
    'vsdiff.draft.edit',
    (target: vscode.CommentThread | vscode.Comment | string, body?: string) =>
      proposal.edit(target, body),
  );
  // Save/Cancel of that editor. The UI hands over the comment carrying the
  // editor's text; the bridge form is (stopId, body).
  command('vsdiff.draft.saveEdit', (target: vscode.Comment | string, body?: string) =>
    proposal.saveEdit(target, body),
  );
  command('vsdiff.draft.cancelEdit', (target: vscode.Comment | string) =>
    proposal.cancelEdit(target),
  );
  command('vsdiff.openReviewBody', () => proposal.openReviewBody());

  // ---- P6: HTML guides (R14) -----------------------------------------------
  command('vsdiff.openGuide', () => guide.open());

  // R18 parity: programmatic comment for e2e and agent harnesses.
  command('vsdiff.debug.comment', (path: string, line: number, body: string) =>
    comments.debugComment(path, line, body),
  );
  command('vsdiff.debug.proposalPayload', () => proposal.payload());
  // Same message handler the guide's webview bridge posts into.
  command('vsdiff.debug.guideNav', (target: string | number, line?: number) =>
    guide.debugNav(target, line),
  );
  command('vsdiff.debug.state', () =>
    debugState(context, controller, outline, comments, navigator, proposal, guide, overview),
  );

  // Deep links (R14, desktop editors): vscode://vsdiff.vsdiff/stop?id=<id>
  // and /guide — external browsers and terminals can drive the review.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);
        if (uri.path === '/stop') {
          const id = params.get('id');
          const state = controller.getState();
          if (id && state.phase === 'loaded') {
            const stop = state.resolved.stops.find((s) => s.stop.id === id);
            if (stop) void navigator.openStop(stop.index);
          }
        } else if (uri.path === '/guide') {
          void vscode.commands.executeCommand('vsdiff.openGuide');
        }
      },
    }),
  );

  const bridge = startBridge(() =>
    debugState(context, controller, outline, comments, navigator, proposal, guide, overview),
  );
  if (bridge) context.subscriptions.push(bridge);

  void controller.reload();
}

function debugState(
  context: vscode.ExtensionContext,
  controller: SessionController,
  outline: OutlineProvider,
  comments: CommentsLayer,
  navigator: Navigator,
  proposal: ProposalLayer,
  guide: GuidePanel,
  overview: OverviewPanel,
) {
  const state = controller.getState();
  const feedback = controller.getFeedback();
  return {
    extension: {
      id: context.extension.id,
      version: context.extension.packageJSON.version as string,
    },
    schemaVersion: SCHEMA_VERSION,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    outline: outline.snapshot(),
    session:
      state.phase === 'loaded'
        ? {
            phase: state.phase,
            title: state.resolved.session.title,
            stops: state.resolved.stops.length,
            currentIndex: controller.getCurrentIndex(),
            stats: state.resolved.stats,
            sessionPath: state.sessionPath,
          }
        : { phase: state.phase, ...(state.phase === 'error' ? { message: state.message } : {}) },
    feedback: {
      events: feedback.events.length,
      threads: comments.threadCounts(),
      verdicts: Object.fromEntries(feedback.verdicts),
      viewed: [...feedback.viewedPaths],
      done: [...feedback.doneStops],
      doneFiles: Object.fromEntries(
        [...feedback.doneFiles].map(([stop, files]) => [stop, [...files]]),
      ),
      seen: [...feedback.seenHunks],
      read: [...feedback.readHunks],
    },
    issues: state.phase === 'loaded' ? state.issues.map((i) => `${i.path}: ${i.message}`) : [],
    proposal: proposal.snapshot(),
    guide: guide.snapshot(),
    overview: overview.snapshot(),
    hunk: navigator.position(),
    perf: controller.perf,
  };
}

export function deactivate(): void {}

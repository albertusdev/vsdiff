import * as vscode from 'vscode';
import { hunkKey, type SessionController } from './controller.ts';
import type { ResolvedHunkRef, ResolvedStop } from './coreTypes.ts';
import { leftUriFor, rightUriFor } from './uris.ts';

// Opens stops as native diff editors and decorates their anchored ranges
// (blueprint §7.2). Head side prefers the real working file so LSP works;
// virtual git content covers deletions and non-checkout refs.

const hunkHighlight = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Full,
});

export class Navigator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private decoratedPath: string | undefined;
  private hunkOrdinal = 0;
  private navigation: Promise<void> = Promise.resolve();

  constructor(private readonly controller: SessionController) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.applyDecorations()),
      controller.onDidChange(() => this.applyDecorations()),
    );
  }

  /** Position within the current stop, for the status bar and the bridge. */
  position(): { hunkOrdinal: number; hunkCount: number } {
    const stop = this.controller.getCurrent();
    return { hunkOrdinal: this.hunkOrdinal, hunkCount: stop?.hunks.length ?? 0 };
  }

  whenIdle(): Promise<void> {
    return this.navigation;
  }

  openStop(index: number, hunkOrdinal = 0): Promise<void> {
    const opened = this.navigation.then(() => this.navigate(index, hunkOrdinal));
    this.navigation = opened.catch(() => {});
    return opened;
  }

  private async navigate(index: number, hunkOrdinal: number): Promise<void> {
    const started = Date.now();
    // Set the hunk cursor BEFORE setCurrentIndex fires the change event, or
    // the status bar renders one position behind.
    this.hunkOrdinal = hunkOrdinal;
    const stop = this.controller.setCurrentIndex(index);
    if (!stop) return;
    this.hunkOrdinal = Math.min(hunkOrdinal, Math.max(stop.hunks.length - 1, 0));
    const ref = stop.hunks[this.hunkOrdinal];
    if (!ref) {
      // Prose-only or fully-stale stop: nothing to open, the outline/status
      // surfaces still moved the cursor.
      void vscode.window.showWarningMessage(
        `vsdiff: stop "${stop.stop.title ?? stop.stop.id}" has no resolvable hunks (stale).`,
      );
      return;
    }
    await this.openHunk(stop, ref);
    this.controller.perf.lastNavMs = Date.now() - started;
  }

  async nextStop(): Promise<void> {
    await this.openStop(this.controller.getCurrentIndex() + 1);
  }

  async prevStop(): Promise<void> {
    await this.openStop(this.controller.getCurrentIndex() - 1);
  }

  /** The universal guided walk: every hunk of every stop, in session order —
   *  through the current stop's hunks first, then over the stop boundary.
   *  Unlike the editor's own diff arrows this follows the REVIEW, not the file. */
  async next(): Promise<void> {
    await this.step(1);
  }

  async prev(): Promise<void> {
    await this.step(-1);
  }

  private async step(delta: 1 | -1): Promise<void> {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    const stops = state.resolved.stops;
    if (stops.length === 0) return;
    const stop = this.controller.getCurrent();
    if (!stop) {
      await this.openStop(delta === 1 ? 0 : stops.length - 1);
      return;
    }
    const target = this.hunkOrdinal + delta;
    if (target >= 0 && target < stop.hunks.length) {
      await this.openStop(stop.index, target);
      return;
    }
    const nextIndex = stop.index + delta;
    if (nextIndex < 0 || nextIndex >= stops.length) {
      vscode.window.setStatusBarMessage(
        delta === 1
          ? 'vsdiff: end of the review — Finish Review (✓✓) when you are done.'
          : 'vsdiff: start of the review.',
        3000,
      );
      return;
    }
    // Walking backward lands on the previous stop's LAST hunk — a true walk,
    // not a jump to its start.
    const arriving = stops[nextIndex];
    const lastHunk = Math.max((arriving?.hunks.length ?? 1) - 1, 0);
    await this.openStop(nextIndex, delta === 1 ? 0 : lastHunk);
  }

  /** Cycle within the current stop's hunks — across files when the stop spans
   *  them (multi-hunk stops are one review idea in several places). Wraps. */
  async nextHunk(): Promise<void> {
    await this.cycleHunk(1);
  }

  async prevHunk(): Promise<void> {
    await this.cycleHunk(-1);
  }

  private async cycleHunk(delta: number): Promise<void> {
    const stop = this.controller.getCurrent();
    if (!stop || stop.hunks.length === 0) return;
    const count = stop.hunks.length;
    await this.openStop(stop.index, (this.hunkOrdinal + delta + count) % count);
  }

  private async openHunk(stop: ResolvedStop, ref: ResolvedHunkRef): Promise<void> {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    const { diff } = state.resolved;

    const file = ref.file;
    const left = leftUriFor(diff, file);
    const right = await rightUriFor(diff, file);

    const title = `${file.path} — ${stop.stop.title ?? stop.stop.id} (vsdiff)`;
    const line = Math.max(ref.hunk.newStart - 1, 0);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: true,
      selection: new vscode.Range(line, 0, line, 0),
      // Diffs always land in the main group; the overview owns the second one
      // ('beside' layout locks it — a diff opening there would be refused).
      viewColumn: vscode.ViewColumn.One,
    } satisfies vscode.TextDocumentShowOptions);
    this.decoratedPath = file.path;
    this.applyDecorations();
    // Coverage signal: this hunk has been on screen. Fire-and-forget — the
    // heatmap folds it live; navigation never waits on the write.
    void this.controller.markSeen(hunkKey(ref));
  }

  /** Highlight every new-side range of the current stop in visible editors. */
  private applyDecorations(): void {
    const stop = this.controller.getCurrent();
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges: vscode.Range[] = [];
      if (stop && this.decoratedPath) {
        for (const { file, hunk } of stop.hunks) {
          if (file.path !== this.decoratedPath) continue;
          if (!editor.document.uri.path.endsWith(file.path)) continue;
          if (hunk.newLines === 0) continue;
          ranges.push(
            new vscode.Range(hunk.newStart - 1, 0, hunk.newStart - 1 + hunk.newLines - 1, 0),
          );
        }
      }
      editor.setDecorations(hunkHighlight, ranges);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    hunkHighlight.dispose();
  }
}

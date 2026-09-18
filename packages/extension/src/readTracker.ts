import * as vscode from 'vscode';
import type { SessionController } from './controller.ts';

// "Fully read" detection for autoDone's on-read mode: a hunk is READ once the
// union of editor lines that have actually been on screen covers its whole
// new-side span. Coverage is sampled on a timer rather than per scroll event —
// a line must stay visible for at least one tick, so flinging the scrollbar
// past a hunk does not count as reading it. Seen (arrival) stays a separate,
// weaker signal feeding the coverage heatmap.

const TICK_MS = 600;

export class ReadTracker implements vscode.Disposable {
  private readonly covered = new Map<string, Set<number>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private lastSession = '';

  constructor(private readonly controller: SessionController) {
    this.timer = setInterval(() => this.sample(), TICK_MS);
  }

  private sample(): void {
    if (this.controller.autoDoneMode() !== 'on-read') return;
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return;
    if (state.sessionPath !== this.lastSession) {
      this.lastSession = state.sessionPath;
      this.covered.clear();
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const file = state.resolved.diff.files.find((candidate) =>
        editor.document.uri.path.endsWith(candidate.path),
      );
      if (!file) continue;
      for (const hunk of file.hunks) {
        const key = `${file.path}:h${file.hunks.indexOf(hunk) + 1}`;
        if (this.controller.getFeedback().readHunks.has(key)) continue;
        // New-side span; a pure deletion has no new lines, so its anchor line
        // being on screen is the whole read.
        const start = Math.max(hunk.newStart - 1, 0);
        const end = start + Math.max(hunk.newLines, 1) - 1;
        const lines = this.covered.get(key) ?? new Set<number>();
        for (const range of editor.visibleRanges) {
          const from = Math.max(range.start.line, start);
          const to = Math.min(range.end.line, end);
          for (let line = from; line <= to; line++) lines.add(line);
        }
        this.covered.set(key, lines);
        if (lines.size >= end - start + 1) {
          void this.controller.markRead(key);
        }
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

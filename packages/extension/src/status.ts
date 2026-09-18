import * as vscode from 'vscode';
import type { SessionController } from './controller.ts';
import type { Navigator } from './navigation.ts';
import type { ProposalTally } from './proposal.ts';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    controller: SessionController,
    private readonly navigator: Navigator,
    /** Proposal mode only: draft triage counts, folded from feedback events. */
    private readonly tally: () => ProposalTally | undefined = () => undefined,
  ) {
    this.item = vscode.window.createStatusBarItem(
      'vsdiff.status',
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.item.name = 'vsdiff';
    this.item.command = 'vsdiff.pickStop';
    this.subscriptions = [
      controller.onDidChange(() => this.render(controller)),
      // Triage decisions arrive as feedback events, not session changes.
      controller.onDidChangeFeedback(() => this.render(controller)),
    ];
    this.render(controller);
  }

  private render(controller: SessionController): void {
    const state = controller.getState();
    if (state.phase !== 'loaded' || state.resolved.stops.length === 0) {
      this.item.hide();
      return;
    }
    const { resolved } = state;
    const index = Math.max(controller.getCurrentIndex(), 0);
    const current = resolved.stops[index];
    const chapterTitle =
      resolved.chapters.find((c) => c.chapter.id === current?.chapterId)?.chapter.title ?? '';
    const { hunkOrdinal, hunkCount } = this.navigator.position();
    const hunkPart = hunkCount > 1 ? ` · hunk ${hunkOrdinal + 1}/${hunkCount}` : '';
    const tally = this.tally();
    const triagePart = tally
      ? ` · ✓${tally.accepted} ✎${tally.edited} ✗${tally.dropped} ?${tally.pending}`
      : '';
    this.item.text = `$(compass) ${index + 1}/${resolved.stops.length} · ${chapterTitle}${hunkPart}${triagePart}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${resolved.session.title}**\n\n`);
    if (current) {
      tooltip.appendMarkdown(`${current.stop.title ?? current.stop.id}\n\n`);
    }
    if (tally) {
      tooltip.appendMarkdown(
        `Draft review — ${tally.accepted} accepted · ${tally.edited} edited · ${tally.dropped} dropped · ${tally.pending} pending\n\n`,
      );
    }
    tooltip.appendMarkdown('_Click to jump to a stop._');
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.item.dispose();
  }
}

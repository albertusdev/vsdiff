import * as vscode from 'vscode';
import type { SessionController } from './controller.ts';
import type { FileStatus, ResolvedSession, ResolvedStop } from './coreTypes.ts';
import { decorationUri } from './decorations.ts';
import { rowIcon, stopIcon } from './icons.ts';

// Session-driven review outline: chapters → stops → files, then the by-file
// pivot (Files → file → the stops that own it — the same change read
// backwards), support, and uncovered groups (blueprint §7.2). Empty/error
// states render via viewsWelcome. Chapters, stops, and the file rows under a
// stop carry native checkboxes (done-tracking, GitHub viewed-files style) that
// roll up in both directions; file rows carry colored A/M/D/R decorations.

export type OutlineNode =
  | { kind: 'message'; text: string }
  | { kind: 'chapter'; id: string; title: string; blurb?: string; stops: ResolvedStop[] }
  | { kind: 'stop'; stop: ResolvedStop }
  | {
      kind: 'stop-file';
      stopIndex: number;
      stopId: string;
      /** Ordinal of this file's first hunk within the stop — the jump target. */
      hunkOrdinal: number;
      path: string;
      status: FileStatus;
      hunkCount: number;
      loc: string;
      /** Every distinct file of the owning stop — the writer-side roll-up needs
       *  the whole set to decide when ticking this row completes the stop. */
      siblings: string[];
    }
  | { kind: 'files-root'; count: number }
  | { kind: 'pivot-file'; path: string; status: FileStatus; hunkCount: number; loc: string }
  | {
      kind: 'pivot-stop';
      stop: ResolvedStop;
      /** Ordinal of this file's first hunk within that stop. */
      hunkOrdinal: number;
      chapterTitle: string;
    }
  | { kind: 'pivot-uncovered'; path: string; hunkCount: number }
  | { kind: 'support-root'; count: number }
  | {
      kind: 'support-group';
      id: string;
      reason: string;
      files: string[];
      hunkCount: number;
      loc: string;
    }
  | { kind: 'uncovered-root'; count: number }
  | {
      kind: 'uncovered-file';
      path: string;
      status: FileStatus;
      hunkCount: number;
      loc: string;
    };

const compact = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

const NO_FILES: ReadonlySet<string> = new Set();

/** The files a stop touches, in first-hunk order. */
const distinctPaths = (stop: ResolvedStop): string[] => [
  ...new Set(stop.hunks.map((ref) => ref.file.path)),
];

/** codiff-style per-row churn, e.g. `+214 −89`. */
function loc(hunks: ReadonlyArray<{ hunk: { additions: number; deletions: number } }>): string {
  let additions = 0;
  let deletions = 0;
  for (const { hunk } of hunks) {
    additions += hunk.additions;
    deletions += hunk.deletions;
  }
  return `+${compact(additions)} −${compact(deletions)}`;
}

export class OutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  private readonly changeEmitter = new vscode.EventEmitter<OutlineNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly controller: SessionController) {
    controller.onDidChange(() => this.changeEmitter.fire(undefined));
    // Feedback events arrive in bursts (a nav writes a seen mark, a roll-up
    // writes several stop-done lines); refreshing per event re-renders rows
    // fast enough to race a click landing on them. Trailing debounce.
    controller.onDidChangeFeedback(() => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.changeEmitter.fire(undefined), 150);
    });
  }

  /** Stops the reviewer has ticked off. Read defensively: older feedback folds
   *  carry no `doneStops`, and then nothing is marked done. */
  private isDone(stopId: string): boolean {
    const feedback = this.controller.getFeedback() as { doneStops?: Set<string> };
    return feedback.doneStops?.has(stopId) ?? false;
  }

  /** Files ticked off individually inside a stop. Read defensively for the same
   *  reason `isDone` does — an older fold carries no `doneFiles`. */
  private doneFilesOf(stopId: string): ReadonlySet<string> {
    const feedback = this.controller.getFeedback() as { doneFiles?: Map<string, Set<string>> };
    return feedback.doneFiles?.get(stopId) ?? NO_FILES;
  }

  /** A stop is done when it is ticked outright, or when every file it touches
   *  has been ticked off one by one — the stop and chapter checkboxes both roll
   *  the file rows up. */
  private isStopDone(stop: ResolvedStop): boolean {
    if (this.isDone(stop.stop.id)) return true;
    const paths = distinctPaths(stop);
    if (paths.length === 0) return false;
    const files = this.doneFilesOf(stop.stop.id);
    return paths.every((path) => files.has(path));
  }

  /** path → the stops that touch it, each with the ordinal of that file's first
   *  hunk inside the stop (the jump target). The by-file pivot is the story
   *  index read backwards, so it is derived per call rather than cached. */
  private stopsByFile(resolved: ResolvedSession): Map<string, OutlineNode[]> {
    const chapterTitles = new Map(resolved.chapters.map((c) => [c.chapter.id, c.chapter.title]));
    const byFile = new Map<string, OutlineNode[]>();
    for (const stop of resolved.stops) {
      const seen = new Set<string>();
      stop.hunks.forEach((ref, ordinal) => {
        if (seen.has(ref.file.path)) return;
        seen.add(ref.file.path);
        const owners = byFile.get(ref.file.path) ?? [];
        owners.push({
          kind: 'pivot-stop',
          stop,
          hunkOrdinal: ordinal,
          chapterTitle: chapterTitles.get(stop.chapterId) ?? stop.chapterId,
        });
        byFile.set(ref.file.path, owners);
      });
    }
    return byFile;
  }

  getChildren(element?: OutlineNode): OutlineNode[] {
    const state = this.controller.getState();
    if (state.phase === 'none') return [];
    if (state.phase === 'core-pending') {
      return element
        ? []
        : [{ kind: 'message', text: 'vsdiff core engine is still building — reload soon' }];
    }
    if (state.phase === 'error') {
      return element ? [] : [{ kind: 'message', text: `Session failed to load: ${state.message}` }];
    }

    const { resolved } = state;
    if (!element) {
      const roots: OutlineNode[] = resolved.chapters.map((c) => ({
        kind: 'chapter',
        id: c.chapter.id,
        title: c.chapter.title,
        ...(c.chapter.blurb !== undefined ? { blurb: c.chapter.blurb } : {}),
        stops: c.stops,
      }));
      if (resolved.diff.files.length > 0) {
        roots.push({ kind: 'files-root', count: resolved.diff.files.length });
      }
      if (resolved.support.length > 0) {
        roots.push({
          kind: 'support-root',
          count: resolved.support.reduce((sum, g) => sum + g.hunks.length, 0),
        });
      }
      if (resolved.uncovered.length > 0) {
        roots.push({
          kind: 'uncovered-root',
          count: resolved.uncovered.reduce((sum, f) => sum + f.hunks.length, 0),
        });
      }
      return roots;
    }

    switch (element.kind) {
      case 'chapter':
        return element.stops.map((stop) => ({ kind: 'stop', stop }));
      case 'stop': {
        // File rows only where they add detail: a single-hunk stop is its own
        // jump target already. Each row jumps to that file's first hunk.
        if (element.stop.hunks.length <= 1) return [];
        const files = new Map<
          string,
          {
            ordinal: number;
            status: FileStatus;
            additions: number;
            deletions: number;
            count: number;
          }
        >();
        element.stop.hunks.forEach((ref, ordinal) => {
          const entry = files.get(ref.file.path);
          if (entry) {
            entry.count += 1;
            entry.additions += ref.hunk.additions;
            entry.deletions += ref.hunk.deletions;
          } else {
            files.set(ref.file.path, {
              ordinal,
              status: ref.file.status,
              additions: ref.hunk.additions,
              deletions: ref.hunk.deletions,
              count: 1,
            });
          }
        });
        const siblings = [...files.keys()];
        return [...files.entries()].map(([path, file]) => ({
          kind: 'stop-file',
          stopIndex: element.stop.index,
          stopId: element.stop.stop.id,
          hunkOrdinal: file.ordinal,
          path,
          status: file.status,
          hunkCount: file.count,
          loc: `+${compact(file.additions)} −${compact(file.deletions)}`,
          siblings,
        }));
      }
      case 'files-root':
        return [...resolved.diff.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({
            kind: 'pivot-file',
            path: file.path,
            status: file.status,
            hunkCount: file.hunks.length,
            loc: `+${compact(file.additions)} −${compact(file.deletions)}`,
          }));
      case 'pivot-file': {
        const owners = this.stopsByFile(resolved).get(element.path);
        if (owners && owners.length > 0) return owners;
        return [{ kind: 'pivot-uncovered', path: element.path, hunkCount: element.hunkCount }];
      }
      case 'support-root':
        return resolved.support.map((group) => ({
          kind: 'support-group',
          id: group.id,
          reason: group.reason,
          files: [...new Set(group.hunks.map((h) => h.file.path))],
          hunkCount: group.hunks.length,
          loc: loc(group.hunks),
        }));
      case 'uncovered-root':
        return resolved.uncovered.map((entry) => ({
          kind: 'uncovered-file',
          path: entry.file.path,
          status: entry.file.status,
          hunkCount: entry.hunks.length,
          loc: loc(entry.hunks.map((hunk) => ({ hunk }))),
        }));
      default:
        return [];
    }
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'chapter': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
        const chapterHunks = node.stops.flatMap((stop) => stop.hunks);
        item.description = `${node.stops.length} ${node.stops.length === 1 ? 'stop' : 'stops'} · ${loc(chapterHunks)}`;
        const done = node.stops.length > 0 && node.stops.every((s) => this.isStopDone(s));
        item.checkboxState = done
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        if (node.blurb) item.tooltip = node.blurb;
        item.iconPath = rowIcon('chapter');
        return item;
      }
      case 'stop': {
        const { stop } = node;
        const isCurrent = this.controller.getCurrent()?.index === stop.index;
        const item = new vscode.TreeItem(
          stop.stop.title ?? stop.stop.id,
          stop.hunks.length > 1
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        const parts: string[] = [];
        if (stop.hunks.length > 0) parts.push(loc(stop.hunks));
        if (stop.stop.severity) parts.push(stop.stop.severity);
        if (stop.priority === 'nice') parts.push('nice');
        if (stop.stale) parts.push('⚠ stale');
        if (isCurrent) parts.push('●');
        item.description = parts.join(' · ');
        item.checkboxState = this.isStopDone(stop)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.tooltip = new vscode.MarkdownString(stop.stop.prose);
        item.iconPath = stopIcon(stop.stop.kind, stop.stop.severity);
        item.contextValue = 'vsdiff-stop';
        item.command = {
          command: 'vsdiff.openStop',
          title: 'Open stop',
          arguments: [stop.index],
        };
        return item;
      }
      case 'stop-file': {
        const base = node.path.split('/').pop() ?? node.path;
        const dir = node.path.slice(0, node.path.length - base.length).replace(/\/$/, '');
        const item = new vscode.TreeItem(base);
        item.description = [
          dir || undefined,
          node.hunkCount > 1 ? `${node.hunkCount} hunks` : undefined,
          node.loc,
        ]
          .filter(Boolean)
          .join(' · ');
        // The colored A/M/D/R badge + label tint ride the decoration provider.
        item.resourceUri = decorationUri(node.path, node.status);
        item.iconPath = rowIcon('file');
        item.tooltip = node.path;
        item.checkboxState =
          this.isDone(node.stopId) || this.doneFilesOf(node.stopId).has(node.path)
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        item.command = {
          command: 'vsdiff.openStop',
          title: 'Open stop at this file',
          arguments: [node.stopIndex, node.hunkOrdinal],
        };
        return item;
      }
      case 'files-root': {
        const item = new vscode.TreeItem('Files', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${node.count} ${node.count === 1 ? 'file' : 'files'} · the change by file`;
        item.iconPath = rowIcon('file');
        return item;
      }
      case 'pivot-file': {
        const base = node.path.split('/').pop() ?? node.path;
        const dir = node.path.slice(0, node.path.length - base.length).replace(/\/$/, '');
        const item = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = [
          dir || undefined,
          `${node.hunkCount} ${node.hunkCount === 1 ? 'hunk' : 'hunks'}`,
          node.loc,
        ]
          .filter(Boolean)
          .join(' · ');
        item.resourceUri = decorationUri(node.path, node.status);
        item.iconPath = rowIcon('file');
        item.tooltip = node.path;
        return item;
      }
      case 'pivot-stop': {
        const { stop } = node;
        const item = new vscode.TreeItem(stop.stop.title ?? stop.stop.id);
        item.description = node.chapterTitle;
        item.tooltip = new vscode.MarkdownString(stop.stop.prose);
        item.iconPath = stopIcon(stop.stop.kind, stop.stop.severity);
        item.command = {
          command: 'vsdiff.openStop',
          title: 'Open stop at this file',
          arguments: [stop.index, node.hunkOrdinal],
        };
        return item;
      }
      case 'pivot-uncovered': {
        const item = new vscode.TreeItem(
          `not covered — ${node.hunkCount} ${node.hunkCount === 1 ? 'hunk' : 'hunks'}`,
        );
        item.iconPath = rowIcon('uncovered');
        item.tooltip = node.path;
        item.command = {
          command: 'vsdiff.openFileDiff',
          title: 'Open file diff',
          arguments: [node.path],
        };
        return item;
      }
      case 'support-root': {
        const item = new vscode.TreeItem('Support', vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${node.count} ${node.count === 1 ? 'hunk' : 'hunks'} kept off the main path`;
        item.iconPath = rowIcon('support');
        return item;
      }
      case 'support-group': {
        const item = new vscode.TreeItem(node.reason);
        item.description = `${node.files.length} ${node.files.length === 1 ? 'file' : 'files'} · ${node.loc}`;
        item.tooltip = node.files.join('\n');
        item.iconPath = rowIcon('support-group');
        return item;
      }
      case 'uncovered-root': {
        const item = new vscode.TreeItem(
          'Not covered by the session',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = `${node.count} ${node.count === 1 ? 'hunk' : 'hunks'}`;
        item.iconPath = rowIcon('uncovered');
        return item;
      }
      case 'uncovered-file': {
        const item = new vscode.TreeItem(node.path);
        item.description = `${node.hunkCount} ${node.hunkCount === 1 ? 'hunk' : 'hunks'} · ${node.loc}`;
        item.resourceUri = decorationUri(node.path, node.status);
        item.iconPath = rowIcon('file');
        item.checkboxState = this.controller.getFeedback().viewedPaths.has(node.path)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.command = {
          command: 'vsdiff.openFileDiff',
          title: 'Open file diff',
          arguments: [node.path],
        };
        return item;
      }
    }
  }

  /** Flat label snapshot for the dev bridge / e2e asserts (3 levels deep). */
  snapshot(): string[] {
    const labels: string[] = [];
    for (const root of this.getChildren()) {
      labels.push(this.getTreeItem(root).label as string);
      for (const child of this.getChildren(root)) {
        labels.push(this.getTreeItem(child).label as string);
        for (const grandchild of this.getChildren(child)) {
          labels.push(this.getTreeItem(grandchild).label as string);
        }
      }
    }
    return labels;
  }
}

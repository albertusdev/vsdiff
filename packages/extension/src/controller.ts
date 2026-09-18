import * as vscode from 'vscode';
import { parseSession, validateSession, type ValidationIssue } from '@vsdiff/schema';
import type {
  CoreApi,
  FeedbackEvent,
  NewFeedbackEvent,
  ResolvedHunkRef,
  ResolvedSession,
  ResolvedStop,
  Thread,
} from './coreTypes.ts';

export type SessionState =
  | { phase: 'none' }
  | { phase: 'core-pending' }
  | { phase: 'error'; message: string; sessionPath: string }
  | {
      phase: 'loaded';
      resolved: ResolvedSession;
      sessionPath: string;
      /** Semantic validation issues (duplicate hunk claims, cap overruns, …).
       *  Non-blocking: an in-flight agent session must render, not brick — but
       *  the reviewer gets told (dogfood: silent duplicates on a 50k PR). */
      issues: ValidationIssue[];
    };

/** Positional hunk key in the schema's own format, e.g. `src/a.ts:h2`. */
export function hunkKey(ref: ResolvedHunkRef): string {
  return `${ref.file.path}:h${ref.file.hunks.indexOf(ref.hunk) + 1}`;
}

export interface PerfMarks {
  loadMs?: number;
  lastNavMs?: number;
}

/** Folded view of feedback.jsonl — the human↔agent conversation so far. */
export interface FeedbackState {
  events: FeedbackEvent[];
  threads: Thread[];
  viewedPaths: Set<string>;
  /** Last verdict per stop id. */
  verdicts: Map<string, string>;
  /** Stops checked off in the overview/tree (last stop-done event wins). */
  doneStops: Set<string>;
  /** Per-file done marks within a stop (`stop-done` events carrying a `path`).
   *  Roll-up is the WRITER's job — this fold stays a dumb last-wins record. */
  doneFiles: Map<string, Set<string>>;
  /** Hunks the reviewer has had on screen (`seen` events; append-only). */
  seenHunks: Set<string>;
  /** Hunks whose whole span has been on screen (`read` events; append-only). */
  readHunks: Set<string>;
}

const SESSION_GLOB = '.vsdiff/sessions/*/session.json';
const FEEDBACK_GLOB = '.vsdiff/sessions/*/feedback.jsonl';

const emptyFeedback = (): FeedbackState => ({
  events: [],
  threads: [],
  viewedPaths: new Set(),
  verdicts: new Map(),
  doneStops: new Set(),
  doneFiles: new Map(),
  seenHunks: new Set(),
  readHunks: new Set(),
});

// Discovers, loads, and resolves the newest review session in the workspace,
// owns the current-stop cursor and the folded feedback state. UI surfaces
// subscribe to onDidChange (session replaced/reloaded) and onDidChangeFeedback
// (conversation advanced).
export class SessionController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly feedbackEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeFeedback = this.feedbackEmitter.event;

  readonly perf: PerfMarks = {};
  private state: SessionState = { phase: 'none' };
  private feedback: FeedbackState = emptyFeedback();
  private currentIndex = -1;
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly core: () => CoreApi | undefined) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${SESSION_GLOB}`);
    for (const event of [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete]) {
      this.disposables.push(event(() => this.scheduleReload()));
    }
    this.disposables.push(watcher);

    const feedbackWatcher = vscode.workspace.createFileSystemWatcher(`**/${FEEDBACK_GLOB}`);
    for (const event of [feedbackWatcher.onDidCreate, feedbackWatcher.onDidChange]) {
      this.disposables.push(event(() => this.scheduleFeedbackRefresh()));
    }
    this.disposables.push(feedbackWatcher);
  }

  getFeedback(): FeedbackState {
    return this.feedback;
  }

  /** Directory holding session.json, feedback.jsonl, result.json. */
  getSessionDir(): string | undefined {
    if (this.state.phase !== 'loaded' && this.state.phase !== 'error') return undefined;
    const path = this.state.sessionPath;
    return path.slice(0, path.lastIndexOf('/'));
  }

  /** Append an event (human side) and refresh the folded state immediately. */
  async appendEvent(event: NewFeedbackEvent): Promise<void> {
    const api = this.core();
    const dir = this.getSessionDir();
    if (!api || !dir) throw new Error('no session loaded');
    await api.appendFeedback(dir, event);
    await this.refreshFeedback();
  }

  private scheduleFeedbackRefresh(): void {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => void this.refreshFeedback(), 150);
  }

  private async refreshFeedback(): Promise<void> {
    const api = this.core();
    const dir = this.getSessionDir();
    if (!api || !dir || this.state.phase !== 'loaded') {
      this.feedback = emptyFeedback();
      this.feedbackEmitter.fire();
      return;
    }
    // Full re-read keeps the fold simple; the log is small at review scale.
    const batch = await api.readFeedback(dir);
    const viewedPaths = new Set<string>();
    const verdicts = new Map<string, string>();
    const doneStops = new Set<string>();
    const doneFiles = new Map<string, Set<string>>();
    const seenHunks = new Set<string>();
    const readHunks = new Set<string>();
    for (const event of batch.events) {
      if (event.type === 'viewed' && typeof event['path'] === 'string') {
        if (event['viewed'] === false) viewedPaths.delete(event['path'] as string);
        else viewedPaths.add(event['path'] as string);
      }
      if (
        event.type === 'verdict' &&
        typeof event['stop'] === 'string' &&
        typeof event['verdict'] === 'string'
      ) {
        verdicts.set(event['stop'] as string, event['verdict'] as string);
      }
      if (event.type === 'stop-done' && typeof event['stop'] === 'string') {
        const stop = event['stop'] as string;
        const path = typeof event['path'] === 'string' ? (event['path'] as string) : undefined;
        if (path !== undefined) {
          const files = doneFiles.get(stop) ?? new Set<string>();
          if (event['done'] === false) files.delete(path);
          else files.add(path);
          doneFiles.set(stop, files);
        } else if (event['done'] === false) {
          doneStops.delete(stop);
          doneFiles.delete(stop); // un-doing the stop un-does its file marks
        } else {
          doneStops.add(stop);
        }
      }
      if (event.type === 'seen' && typeof event['hunk'] === 'string') {
        seenHunks.add(event['hunk'] as string);
      }
      if (event.type === 'read' && typeof event['hunk'] === 'string') {
        readHunks.add(event['hunk'] as string);
      }
    }
    this.feedback = {
      events: batch.events,
      threads: api.buildThreads(batch.events),
      viewedPaths,
      verdicts,
      doneStops,
      doneFiles,
      seenHunks,
      readHunks,
    };
    this.feedbackEmitter.fire();
  }

  /** How seen/read hunks sync checkmarks. Old boolean values keep their old
   *  meaning (true was arrival-marks, false was off); the default is on-read. */
  autoDoneMode(): 'on-read' | 'on-visit' | 'off' {
    const raw = vscode.workspace.getConfiguration('vsdiff').get<unknown>('review.autoDone');
    if (raw === 'on-visit' || raw === true) return 'on-visit';
    if (raw === 'off' || raw === false) return 'off';
    return 'on-read';
  }

  /** Record that a hunk was on screen — at most one event per hunk per session. */
  async markSeen(key: string): Promise<void> {
    if (this.state.phase !== 'loaded') return;
    if (this.feedback.seenHunks.has(key)) return;
    this.feedback.seenHunks.add(key); // optimistic: dedupes concurrent navs
    await this.appendEvent({ type: 'seen', hunk: key }).catch(() => {});
    if (this.autoDoneMode() === 'on-visit') {
      await this.autoDoneFrom(key, this.feedback.seenHunks).catch(() => {});
    }
  }

  /** Record that a hunk's whole span has been on screen (the ReadTracker's
   *  call) — the stronger signal that drives on-read checkmark sync. */
  async markRead(key: string): Promise<void> {
    if (this.state.phase !== 'loaded') return;
    if (this.feedback.readHunks.has(key)) return;
    this.feedback.readHunks.add(key);
    await this.appendEvent({ type: 'read', hunk: key }).catch(() => {});
    if (this.autoDoneMode() === 'on-read') {
      await this.autoDoneFrom(key, this.feedback.readHunks).catch(() => {});
    }
  }

  /** Seen-driven checkmarks: once every hunk of a stop has been on screen the
   *  stop checks itself off; a file inside a multi-file stop checks off when
   *  its own hunks are all seen. Ownership is first-claim (matching how
   *  duplicate claims resolve), and an existing human mark is never rewritten. */
  private async autoDoneFrom(key: string, basis: ReadonlySet<string>): Promise<void> {
    if (this.state.phase !== 'loaded') return;
    const owner = this.state.resolved.stops.find((stop) =>
      stop.hunks.some((ref) => hunkKey(ref) === key),
    );
    if (!owner || this.feedback.doneStops.has(owner.stop.id)) return;
    const seen = basis;
    if (owner.hunks.every((ref) => seen.has(hunkKey(ref)))) {
      await this.appendEvent({ type: 'stop-done', stop: owner.stop.id, done: true });
      return;
    }
    const path = owner.hunks.find((ref) => hunkKey(ref) === key)?.file.path;
    if (path === undefined) return;
    if (this.feedback.doneFiles.get(owner.stop.id)?.has(path)) return;
    const fileRefs = owner.hunks.filter((ref) => ref.file.path === path);
    if (fileRefs.every((ref) => seen.has(hunkKey(ref)))) {
      await this.appendEvent({ type: 'stop-done', stop: owner.stop.id, path, done: true });
    }
  }

  getState(): SessionState {
    return this.state;
  }

  getCurrent(): ResolvedStop | undefined {
    if (this.state.phase !== 'loaded') return undefined;
    return this.state.resolved.stops[this.currentIndex];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  setCurrentIndex(index: number): ResolvedStop | undefined {
    if (this.state.phase !== 'loaded') return undefined;
    const stops = this.state.resolved.stops;
    if (stops.length === 0) return undefined;
    this.currentIndex = Math.min(Math.max(index, 0), stops.length - 1);
    this.changeEmitter.fire();
    return stops[this.currentIndex];
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    // Debounce: agents rewrite session files atomically but watchers can fire
    // several events per rename.
    this.reloadTimer = setTimeout(() => void this.reload(), 200);
  }

  async reload(): Promise<void> {
    const api = this.core();
    if (!api) {
      this.setState({ phase: 'core-pending' });
      return;
    }
    const files = await vscode.workspace.findFiles(SESSION_GLOB, '**/node_modules/**', 25);
    if (files.length === 0) {
      this.setState({ phase: 'none' });
      return;
    }
    // Newest session directory wins (directory names sort by date prefix by
    // convention; fall back to mtime when they don't).
    const stats = await Promise.all(
      files.map(async (uri) => ({ uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const target = stats[0]!.uri;

    const started = Date.now();
    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
      const parsed = parseSession(raw);
      if (!parsed.ok) {
        this.setState({
          phase: 'error',
          message: parsed.errors.join('; '),
          sessionPath: target.fsPath,
        });
        return;
      }
      const workspaceRoot = vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath;
      if (!workspaceRoot) {
        this.setState({
          phase: 'error',
          message: 'session outside workspace',
          sessionPath: target.fsPath,
        });
        return;
      }
      // Full semantic validation (duplicate claims, caps) — parseSession only
      // shape-checks, which is how an invalid agent session once rendered
      // duplicated hunks silently. Issues inform, they never block the load.
      const validated = validateSession(parsed.session);
      const issues = validated.ok ? [] : validated.errors;
      const diff = await api.computeDiff(workspaceRoot, parsed.session.source);
      const resolved = api.resolveSession(parsed.session, diff);
      this.perf.loadMs = Date.now() - started;
      this.state = { phase: 'loaded', resolved, sessionPath: target.fsPath, issues };
      if (this.currentIndex < 0 && resolved.stops.length > 0) {
        this.currentIndex = 0;
      }
      this.changeEmitter.fire();
      await this.refreshFeedback();
      // Attachment signal (dogfood friction #4): lets an agent's timed-out
      // --await distinguish "no editor ever loaded this" from "reviewer walked
      // away". One event per session lifetime is enough.
      if (!this.feedback.events.some((event) => event.type === 'opened')) {
        await this.appendEvent({ type: 'opened' }).catch(() => {});
      }
    } catch (error) {
      this.setState({
        phase: 'error',
        message: (error as Error).message,
        sessionPath: target.fsPath,
      });
    }
  }

  private setState(state: SessionState): void {
    this.state = state;
    if (state.phase !== 'loaded') {
      this.currentIndex = -1;
    }
    this.changeEmitter.fire();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    for (const d of this.disposables) d.dispose();
    this.changeEmitter.dispose();
    this.feedbackEmitter.dispose();
  }
}

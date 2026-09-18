import * as vscode from 'vscode';
import type { SessionController } from './controller.ts';
import type { Navigator } from './navigation.ts';
import { rightUriFor } from './uris.ts';
import { containedFile, isRelativeFilePath } from './safe-path.ts';

// HTML guides (blueprint §7.6, R14): the escape hatch for when the bounded UI
// isn't enough. The agent ships an HTML file inside the session directory and
// we render it in a webview pinned to that directory, with a bridge injected so
// the guide can drive the editor — open a stop, open a file:line, step.
//
// The guide is repo content that runs scripts, so it renders with exactly the
// trust of the repo: an untrusted workspace gets a static explainer instead, no
// scripts and no guide content beyond its title.

const VIEW_TYPE = 'vsdiff.guide';
const MANAGE_TRUST = 'workbench.trust.manage';

export interface GuideStopState {
  id: string;
  index: number;
  title: string;
  kind: string;
}

/** What the guide sees as `window.vsdiff.state` (read-only mirror). */
export interface GuideState {
  title: string;
  stops: GuideStopState[];
  currentIndex: number;
}

export interface GuideSnapshot {
  /** A `guide.html` is declared AND present on disk. */
  available: boolean;
  open: boolean;
  trusted: boolean;
  /** The injected bridge has handshaked — i.e. the guide's scripts are running.
   *  Stays false for the untrusted explainer, which has none. */
  ready: boolean;
  path?: string;
}

/** Anything with a scheme, a root-relative path, a bare query or a fragment is
 *  left exactly as the agent wrote it; everything else is guide-relative. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i;
const ASSET_REF = /\b(src|href)=(["'])([^"']*)\2/gi;
const AGENT_CSP = /<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function splitRef(value: string): { path: string; suffix: string } {
  const cut = value.search(/[?#]/);
  return cut < 0
    ? { path: value, suffix: '' }
    : { path: value.slice(0, cut), suffix: value.slice(cut) };
}

/** Rewrite relative asset references to webview uris. Deliberately conservative:
 *  it only touches src=/href= with a quoted, relative value. */
export function rewriteAssetRefs(
  html: string,
  baseDir: vscode.Uri,
  webview: vscode.Webview,
): string {
  return html.replace(ASSET_REF, (match, attribute: string, quote: string, value: string) => {
    if (value === '' || NOT_RELATIVE.test(value)) return match;
    const { path, suffix } = splitRef(value);
    if (path === '') return match;
    const resolved = webview.asWebviewUri(vscode.Uri.joinPath(baseDir, path));
    return `${attribute}=${quote}${resolved.toString()}${suffix}${quote}`;
  });
}

function cspMeta(webview: vscode.Webview): string {
  const source = webview.cspSource;
  // No network, ever: everything the guide loads comes from the session dir.
  // Agent guides inline their JS and CSS, hence 'unsafe-inline'.
  const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "connect-src 'none'",
    `img-src ${source} data:`,
    `media-src ${source}`,
    `font-src ${source}`,
    `style-src ${source} 'unsafe-inline'`,
    `script-src ${source} 'unsafe-inline'`,
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

function injectBeforeBodyEnd(html: string, injection: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at < 0) return `${html}\n${injection}`;
  return `${html.slice(0, at)}${injection}\n${html.slice(at)}`;
}

/** The bridge (blueprint §7.6). No framework, no build step: one IIFE that
 *  exposes `window.vsdiff` and turns `vsdiff://` links into the same messages. */
function bridgeScript(state: GuideState): string {
  const seed = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<script>
(function () {
  var api = acquireVsCodeApi();
  var post = function (command, args) {
    api.postMessage({ type: 'vsdiff', command: command, args: args || [] });
  };
  var bridge = {
    state: ${seed},
    openStop: function (idOrIndex) { post('openStop', [idOrIndex]); },
    openFile: function (path, line) { post('openFile', [path, line]); },
    nextStop: function () { post('nextStop'); },
    prevStop: function () { post('prevStop'); }
  };
  window.vsdiff = bridge;
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || message.type !== 'state') return;
    bridge.state = message.state;
    window.dispatchEvent(new CustomEvent('vsdiff:state', { detail: message.state }));
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href^="vsdiff:"]') : null;
    if (!link) return;
    event.preventDefault();
    var rest = String(link.getAttribute('href') || '').replace(/^vsdiff:(\\/\\/)?/i, '');
    var cut = rest.indexOf('/');
    var kind = cut < 0 ? rest : rest.slice(0, cut);
    var value = cut < 0 ? '' : rest.slice(cut + 1);
    if (kind === 'stop') {
      post('openStop', [decodeURIComponent(value)]);
    } else if (kind === 'file') {
      var parts = /^(.*?)(?::(\\d+))?$/.exec(value) || [];
      post('openFile', [decodeURIComponent(parts[1] || ''), parts[2] ? Number(parts[2]) : undefined]);
    }
  });
  post('ready');
})();
</script>`;
}

/** Guide html as the webview sees it: agent CSP dropped for ours, relative
 *  assets rewritten, bridge appended. */
export function buildGuideHtml(
  source: string,
  guideUri: vscode.Uri,
  webview: vscode.Webview,
  state: GuideState,
): string {
  const baseDir = vscode.Uri.joinPath(guideUri, '..');
  let html = source.replace(AGENT_CSP, '');
  html = rewriteAssetRefs(html, baseDir, webview);
  // Apply the policy before ANY agent markup, including scripts before <head>.
  html = `${cspMeta(webview)}\n${html}`;
  return injectBeforeBodyEnd(html, bridgeScript(state));
}

const PAGE_STYLE = `<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 2rem 2.5rem; line-height: 1.55; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
  p { max-width: 46rem; }
  code { font-family: var(--vscode-editor-font-family); }
  a { color: var(--vscode-textLink-foreground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>`;

function staticPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(title)}</title>
${PAGE_STYLE}
</head>
<body>
${body}
</body>
</html>`;
}

/** Trust gate: the guide's own markup never reaches the webview here. */
function untrustedPage(title: string): string {
  return staticPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>This session ships an HTML guide. Guides are repository content that runs scripts, so vsdiff
renders them only in a <strong>trusted</strong> workspace.</p>
<p><a href="command:${MANAGE_TRUST}">Manage Workspace Trust</a>, then reopen this panel.</p>
<p class="hint">Everything else keeps working untrusted: the outline, diffs, comments, and verdicts.</p>`,
  );
}

function errorPage(title: string, message: string): string {
  return staticPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>vsdiff could not read this session's HTML guide.</p>
<p class="hint">${escapeHtml(message)}</p>`,
  );
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class GuidePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private available = false;
  private ready = false;
  private relativePath: string | undefined;

  constructor(
    private readonly controller: SessionController,
    private readonly navigator: Navigator,
  ) {
    this.disposables.push(
      controller.onDidChange(() => this.pushState()),
      // Granting trust mid-session must upgrade the explainer into the guide.
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.render()),
    );
  }

  // ------------------------------------------------------------- discovery

  private declaredPath(): string | undefined {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return undefined;
    const html = state.resolved.session.guide?.html;
    return typeof html === 'string' && html.trim() !== '' ? html : undefined;
  }

  private async guideUri(): Promise<vscode.Uri | undefined> {
    const dir = this.controller.getSessionDir();
    const relative = this.declaredPath();
    const path = dir && relative ? await containedFile(dir, relative) : undefined;
    return path ? vscode.Uri.file(path) : undefined;
  }

  /** Recomputes availability for the view-title button and the bridge snapshot.
   *  Cheap enough to run on every session change — agents add and remove guide
   *  files while the panel is open. */
  async refresh(): Promise<boolean> {
    this.relativePath = this.declaredPath();
    const uri = await this.guideUri();
    this.available = uri ? await fileExists(uri) : false;
    return this.available;
  }

  // ----------------------------------------------------------------- panel

  private title(): string {
    const state = this.controller.getState();
    return state.phase === 'loaded' ? `${state.resolved.session.title} · guide` : 'vsdiff guide';
  }

  private webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    const trusted = vscode.workspace.isTrusted;
    const dir = this.controller.getSessionDir();
    return {
      enableScripts: trusted,
      // The explainer's only interactive element; guides themselves get none.
      enableCommandUris: trusted ? false : [MANAGE_TRUST],
      localResourceRoots: trusted && dir ? [vscode.Uri.file(dir)] : [],
      // Guides are re-read from disk on open, so there is no context worth
      // keeping: agents iterate on them while the panel sits in the background.
      retainContextWhenHidden: false,
    };
  }

  /** `vsdiff.openGuide`: open (or reveal) the panel, always re-reading the file. */
  async open(): Promise<GuideSnapshot | undefined> {
    if (this.controller.getState().phase !== 'loaded') {
      void vscode.window.showInformationMessage('vsdiff: no review session loaded.');
      return undefined;
    }
    const relative = this.declaredPath();
    if (!relative) {
      void vscode.window.showInformationMessage(
        'vsdiff: this session ships no HTML guide — an agent adds one with "guide": { "html": "guide/index.html" }.',
      );
      return undefined;
    }
    await this.refresh();
    if (!this.available) {
      void vscode.window.showWarningMessage(
        `vsdiff: guide file "${relative}" is missing from the session folder.`,
      );
      return undefined;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
    } else {
      const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        this.title(),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        this.webviewOptions(),
      );
      panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.ready = false;
        },
        undefined,
        this.disposables,
      );
      panel.webview.onDidReceiveMessage(
        (message: unknown) => void this.receive(message),
        undefined,
        this.disposables,
      );
      this.panel = panel;
    }
    await this.render();
    return this.snapshot();
  }

  private async render(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    panel.title = this.title();
    panel.webview.options = this.webviewOptions();
    // Every render is a fresh load: the bridge handshakes again or it never ran.
    this.ready = false;

    if (!vscode.workspace.isTrusted) {
      panel.webview.html = untrustedPage(this.title());
      return;
    }
    const uri = await this.guideUri();
    if (!uri) return;
    try {
      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      panel.webview.html = buildGuideHtml(source, uri, panel.webview, this.guideState());
    } catch (error) {
      panel.webview.html = errorPage(this.title(), (error as Error).message);
    }
  }

  // ----------------------------------------------------------------- state

  private guideState(): GuideState {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return { title: '', stops: [], currentIndex: -1 };
    return {
      title: state.resolved.session.title,
      stops: state.resolved.stops.map((stop) => ({
        id: stop.stop.id,
        index: stop.index,
        title: stop.stop.title ?? stop.stop.id,
        kind: stop.stop.kind ?? 'walkthrough',
      })),
      currentIndex: this.controller.getCurrentIndex(),
    };
  }

  private pushState(): void {
    if (!this.panel || !vscode.workspace.isTrusted) return;
    void this.panel.webview.postMessage({ type: 'state', state: this.guideState() });
  }

  // -------------------------------------------------------------- messages

  private async receive(message: unknown): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    if (!isRecord(message) || message['type'] !== 'vsdiff') return;
    const args = Array.isArray(message['args']) ? (message['args'] as unknown[]) : [];
    await this.dispatch(String(message['command'] ?? ''), args);
  }

  /** The one place guide navigation happens: the webview bridge and the debug
   *  command (R18 parity) both land here. */
  async dispatch(command: string, args: readonly unknown[] = []): Promise<unknown> {
    switch (command) {
      case 'ready':
        this.ready = true;
        this.pushState();
        return this.snapshot();
      case 'openStop':
        return this.openStop(args[0]);
      case 'openFile':
        return this.openFile(args[0], args[1]);
      case 'nextStop':
        await this.focusEditors();
        return this.navigator.nextStop();
      case 'prevStop':
        await this.focusEditors();
        return this.navigator.prevStop();
      default:
        return undefined;
    }
  }

  /** R18 parity for `vsdiff.debug.guideNav`: a stop id (or index) navigates, a
   *  value with a slash is a file path, and the step verbs pass through. Stop
   *  ids are slugs, so the slash is an unambiguous discriminator. */
  async debugNav(target: string | number, line?: number): Promise<unknown> {
    if (target === 'nextStop' || target === 'prevStop') return this.dispatch(target);
    if (typeof target === 'string' && target.includes('/')) {
      return this.dispatch('openFile', [target, line]);
    }
    return this.dispatch('openStop', [target]);
  }

  /** Navigation triggered from the guide must land in the editor group beside
   *  it, not replace the panel that asked for it. (A guide sharing group one has
   *  nowhere else to go — it yields to the diff.) */
  private async focusEditors(): Promise<void> {
    const column = this.panel?.viewColumn;
    if (column !== undefined && column !== vscode.ViewColumn.One) {
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    }
  }

  private indexOf(target: unknown): number {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return -1;
    const stops = state.resolved.stops;
    if (typeof target === 'number') return Number.isInteger(target) ? target : -1;
    if (typeof target !== 'string') return -1;
    const byId = stops.findIndex((candidate) => candidate.stop.id === target);
    if (byId >= 0) return byId;
    return /^\d+$/.test(target) ? Number(target) : -1;
  }

  private async openStop(target: unknown): Promise<{ id: string; index: number } | undefined> {
    const state = this.controller.getState();
    if (state.phase !== 'loaded') return undefined;
    const index = this.indexOf(target);
    const stop = state.resolved.stops[index];
    if (!stop) {
      void vscode.window.showWarningMessage(
        `vsdiff: the guide linked to an unknown stop (${JSON.stringify(target)}).`,
      );
      return undefined;
    }
    await this.focusEditors();
    await this.navigator.openStop(index);
    return { id: stop.stop.id, index };
  }

  private async openFile(pathArg: unknown, lineArg: unknown): Promise<string | undefined> {
    const state = this.controller.getState();
    if (state.phase !== 'loaded' || typeof pathArg !== 'string' || !isRelativeFilePath(pathArg))
      return undefined;
    const { diff } = state.resolved;
    const changed = diff.files.find((candidate) => candidate.path === pathArg);
    // Changed files open on their head side (LSP alive, same as a stop); any
    // other path is an ordinary workspace file.
    const file = changed ? undefined : await containedFile(diff.repoRoot, pathArg);
    if (!changed && !file) return undefined;
    const uri = changed ? await rightUriFor(diff, changed) : vscode.Uri.file(file!);
    const line = typeof lineArg === 'number' && lineArg > 0 ? Math.floor(lineArg) - 1 : undefined;
    await this.focusEditors();
    try {
      await vscode.window.showTextDocument(uri, {
        preview: true,
        ...(line === undefined ? {} : { selection: new vscode.Range(line, 0, line, 0) }),
      });
    } catch {
      void vscode.window.showWarningMessage(
        `vsdiff: the guide linked to "${pathArg}", which is not in this workspace.`,
      );
      return undefined;
    }
    return uri.toString();
  }

  // -------------------------------------------------------------- snapshot

  snapshot(): GuideSnapshot {
    return {
      available: this.available,
      open: this.panel !== undefined,
      trusted: vscode.workspace.isTrusted,
      ready: this.ready,
      ...(this.relativePath === undefined ? {} : { path: this.relativePath }),
    };
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

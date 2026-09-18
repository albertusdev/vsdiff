import * as vscode from 'vscode';
import type { FileStatus } from './coreTypes.ts';

// Colored file-status decorations for outline rows (the GitHub-PR-extension
// look): a tree item's description text is monochrome by API, but a
// FileDecorationProvider can tint the label and hang a colored one-letter
// badge on any resourceUri — the same channel git's SCM view uses. The status
// travels in the uri query so the provider needs no session state.

export const DECORATION_SCHEME = 'vsdiff-row';

const BADGE: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

// charts.* on purpose, NOT gitDecoration.*: the gitDecoration color variables
// come from the git builtin's `colors` contribution, which serve-web does not
// load — a ThemeColor pointing at an unregistered id renders as PLAIN TEXT
// with no error (dogfood round 6: "why is there no colors on the sidebar?!").
// charts.* is registered by the workbench core, so it exists on every host.
const COLOR: Record<FileStatus, string> = {
  added: 'charts.green',
  modified: 'charts.blue',
  deleted: 'charts.red',
  renamed: 'charts.purple',
};

export function decorationUri(path: string, status: FileStatus): vscode.Uri {
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: `/${path}`, query: status });
}

export class OutlineDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) return undefined;
    const status = uri.query as FileStatus;
    if (!(status in BADGE)) return undefined;
    return new vscode.FileDecoration(BADGE[status], status, new vscode.ThemeColor(COLOR[status]));
  }
}

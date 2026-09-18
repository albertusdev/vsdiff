import * as vscode from 'vscode';
import type { Severity, StopKind } from '@vsdiff/schema';

// The vsdiff row icons (media/icons/{light,dark}/*.svg): one hand-drawn family
// instead of codicons, so a review outline reads as vsdiff at a glance. Finding
// marks carry fixed severity colours legible on either theme — their two files
// are identical, keeping the light/dark pair uniform for every name.

const EXTENSION_ID = 'vsdiff.vsdiff';

export type IconName =
  | 'chapter'
  | 'walkthrough'
  | 'question'
  | 'verify'
  | 'finding-info'
  | 'finding-minor'
  | 'finding-major'
  | 'finding-blocker'
  | 'support'
  | 'support-group'
  | 'uncovered'
  | 'file';

export interface IconPath {
  light: vscode.Uri;
  dark: vscode.Uri;
}

let root: vscode.Uri | undefined;

function iconRoot(): vscode.Uri {
  // The controller has no ExtensionContext, so the root comes from the
  // registry; it is available from activation onward and cached after the
  // first hit. The empty fallback only renders no icon — never throws mid-paint.
  root ??= vscode.extensions.getExtension(EXTENSION_ID)?.extensionUri;
  return root ?? vscode.Uri.file('');
}

export function rowIcon(name: IconName): IconPath {
  const base = iconRoot();
  return {
    light: vscode.Uri.joinPath(base, 'media', 'icons', 'light', `${name}.svg`),
    dark: vscode.Uri.joinPath(base, 'media', 'icons', 'dark', `${name}.svg`),
  };
}

const BY_SEVERITY: Record<Severity, IconName> = {
  info: 'finding-info',
  minor: 'finding-minor',
  major: 'finding-major',
  blocker: 'finding-blocker',
};

const BY_KIND: Record<StopKind, IconName> = {
  walkthrough: 'walkthrough',
  finding: 'finding-info',
  question: 'question',
  verify: 'verify',
};

/** Stop rows: findings rank by severity (info when unranked), others by kind. */
export function stopIcon(kind: StopKind | undefined, severity: Severity | undefined): IconPath {
  if (kind === 'finding' && severity) {
    return rowIcon(BY_SEVERITY[severity] ?? 'finding-info');
  }
  return rowIcon(BY_KIND[kind ?? 'walkthrough'] ?? 'walkthrough');
}

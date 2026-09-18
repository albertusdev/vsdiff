import * as vscode from 'vscode';
import type { DiffFile, DiffResult } from './coreTypes.ts';
import { emptyUri, toGitUri } from './gitFs.ts';
import { containedFile } from './safe-path.ts';

/** Prefer the exact base used to compute the hunk inventory. */
export function baseRefFor(diff: DiffResult): string {
  if (diff.baseRef) return diff.baseRef;
  const source = diff.source;
  if (source.type === 'range') return source.base ?? 'HEAD';
  if (source.type === 'commit') return `${diff.headSha ?? 'HEAD'}^`;
  return 'HEAD';
}

export function headRefFor(diff: DiffResult): string {
  // An empty ref makes git show read :path from the index.
  if (diff.source.type === 'staged') return '';
  const source = diff.source;
  return source.type === 'range' || source.type === 'commit' ? (diff.headSha ?? 'HEAD') : 'HEAD';
}

export function headUriFor(diff: DiffResult, path: string): vscode.Uri {
  const uri = toGitUri(diff.repoRoot, headRefFor(diff), path);
  if (!diff.indexRevision) return uri;
  const query = new URLSearchParams(uri.query);
  query.set('indexRevision', diff.indexRevision);
  return uri.with({ query: query.toString() });
}

export function leftUriFor(diff: DiffResult, file: DiffFile): vscode.Uri {
  if (file.status === 'added') return emptyUri(diff.repoRoot);
  return toGitUri(diff.repoRoot, baseRefFor(diff), file.oldPath ?? file.path);
}

/** Only working-tree reviews read the checkout. Historical and staged reviews
 *  must show the selected snapshot even when the checkout has other edits. */
export async function rightUriFor(diff: DiffResult, file: DiffFile): Promise<vscode.Uri> {
  if (file.status === 'deleted') return emptyUri(diff.repoRoot);
  if (diff.source.type !== 'working-tree') {
    return headUriFor(diff, file.path);
  }
  const onDisk = vscode.Uri.joinPath(vscode.Uri.file(diff.repoRoot), file.path);
  try {
    if (!(await containedFile(diff.repoRoot, file.path))) {
      return headUriFor(diff, file.path);
    }
    return onDisk;
  } catch {
    return headUriFor(diff, file.path);
  }
}

/** Repo-relative posix path for a head-side document uri, or undefined when the
 *  document belongs to neither the workspace nor the vsdiff-git scheme. */
export function repoPathOf(uri: vscode.Uri, repoRoot: string): string | undefined {
  if (uri.scheme === 'vsdiff-git') return uri.path.replace(/^\//, '');
  const root = vscode.Uri.file(repoRoot).path.replace(/\/$/, '');
  if (uri.path.startsWith(`${root}/`)) return uri.path.slice(root.length + 1);
  return undefined;
}

import * as vscode from 'vscode';
import type { CoreApi } from './coreTypes.ts';

// Read-only virtual documents at arbitrary git refs (GH-PR-extension pattern,
// blueprint §7.2): a FileSystemProvider rather than a content provider so diff
// tabs restore across reloads (onFileSystem:vsdiff-git) and get decorations.
// URI shape: vsdiff-git:/<repo-relative-path>?ref=<ref>&root=<encoded fsPath>
// The special path EMPTY_PATH serves zero bytes — the blank side of add/delete
// diffs.

export const GIT_SCHEME = 'vsdiff-git';
export const EMPTY_PATH = '__vsdiff_empty__';

export function toGitUri(root: string, ref: string, repoRelativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${repoRelativePath}`,
    query: new URLSearchParams({ ref, root }).toString(),
  });
}

export function emptyUri(root: string): vscode.Uri {
  return toGitUri(root, 'empty', EMPTY_PATH);
}

function parseGitUri(uri: vscode.Uri): { root: string; ref: string; path: string } {
  const params = new URLSearchParams(uri.query);
  const root = params.get('root') ?? '';
  const ref = params.get('ref') ?? 'HEAD';
  return { root, ref, path: uri.path.replace(/^\//, '') };
}

export class GitFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  // VS Code requests stat and readFile for the same blob. Commit-addressed
  // contents are immutable, so share those reads without caching the index.
  private readonly blobs = new Map<string, Promise<Uint8Array | null>>();

  constructor(private readonly core: () => CoreApi | undefined) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.read(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: bytes.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.read(uri);
  }

  private async read(uri: vscode.Uri): Promise<Uint8Array> {
    const { root, ref, path } = parseGitUri(uri);
    if (path === EMPTY_PATH) {
      return new Uint8Array();
    }
    const api = this.core();
    if (!api) {
      throw vscode.FileSystemError.Unavailable('vsdiff core engine not loaded');
    }
    const immutable = /^[a-f0-9]{40}(?:\^)?$/.test(ref);
    const key = uri.toString();
    let pending = immutable ? this.blobs.get(key) : undefined;
    if (!pending) {
      pending = api.showFile(root, ref, path);
      if (immutable) {
        if (this.blobs.size >= 64) this.blobs.delete(this.blobs.keys().next().value!);
        this.blobs.set(key, pending);
        void pending.catch(() => this.blobs.delete(key));
      }
    }
    const bytes = await pending;
    if (bytes === null) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return bytes;
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('vsdiff-git is read-only');
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('vsdiff-git is read-only');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('vsdiff-git is read-only');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('vsdiff-git is read-only');
  }
}

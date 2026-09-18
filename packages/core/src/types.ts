// P1 public contract for @vsdiff/core (blueprint §6, §7.1). This file is the
// seam between the git engine, the resolver, the CLI, and the extension —
// changes here need tech-lead review.

import type { SessionSource } from '@vsdiff/schema';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffHunk {
  /** `${file.path}:h${n}` — n is the 1-based position in this file's patch. */
  id: string;
  n: number;
  /** The `@@ -a,b +c,d @@ …` line, verbatim. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Added/removed line counts within this hunk. */
  additions: number;
  deletions: number;
  /** Full hunk text including the header line, exactly as git emitted it. */
  text: string;
}

export interface DiffFile {
  /** New-side repo-relative posix path (old path for deletions). */
  path: string;
  /** Old path when status is 'renamed'. */
  oldPath?: string;
  status: FileStatus;
  /** Binary files carry one synthetic hunk `${path}:h1` with empty text. */
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffResult {
  source: SessionSource;
  repoRoot: string;
  /** Resolved head-side commit SHA (HEAD for working-tree/staged sources). */
  headSha: string | null;
  /** Resolved base used by Git, including the merge base for branch ranges. */
  baseRef?: string;
  /** Distinguishes index documents across reloads in editors that cache URIs. */
  indexRevision?: string;
  /** Ordered as git emits. */
  files: DiffFile[];
}

export interface Diffstat {
  files: number;
  hunks: number;
  additions: number;
  deletions: number;
}

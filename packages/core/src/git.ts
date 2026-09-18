// The git engine: turn a SessionSource into a parsed diff, read blobs at a ref,
// and summarise. Every git call goes through execFile with an argv array — no
// shell, ever, because refs and paths come from session files.

import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionSource } from '@vsdiff/schema';
import { parseUnifiedDiff } from './diff-parse.ts';
import type { DiffResult, Diffstat } from './types.ts';

/** git's canonical empty tree — the base for root commits and unborn HEADs. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The L fixture's patch is ~1 MB; leave room for a genuinely large PR. */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * `--src-prefix`/`--dst-prefix`/`--no-relative` pin the output shape the parser
 * relies on against user config (`diff.noprefix`, `diff.mnemonicPrefix`,
 * `diff.srcPrefix`, `diff.relative`).
 */
const DIFF_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  '--unified=3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-relative',
];

/** `git show <ref>:<path>` when the blob simply isn't there — not a failure. */
const MISSING_AT_REF =
  /does not exist in|exists on disk, but not in|invalid object name|unknown revision or path not in the working tree|does not exist in the index/;

export class GitError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${code ?? 'null'}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function execGit(repoRoot: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd: repoRoot,
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        // LC_ALL pins git's messages to English so the "missing at ref" match
        // below survives a localised environment.
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
        const text = stderr.toString('utf8');
        if (!error) {
          resolve({ code: 0, stdout, stderr: text });
          return;
        }
        if (typeof error.code !== 'number') {
          // Spawn failure (git missing), signal, or maxBuffer overflow.
          reject(new GitError(args, null, error.message || text));
          return;
        }
        resolve({ code: error.code, stdout, stderr: text });
      },
    );
  });
}

/** Refs come from session files; a leading `-` would be read as an option. */
function requireRev(value: string | undefined, field: string, type: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`source.${field} is required for a '${type}' source`);
  }
  if (value.startsWith('-')) {
    throw new Error(`source.${field} must not start with '-': ${value}`);
  }
  return value;
}

/** `<rev>^{commit}` — peels tags; null when the rev doesn't resolve. */
async function revParse(repoRoot: string, rev: string): Promise<string | null> {
  const run = await execGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (run.code !== 0) return null;
  const sha = run.stdout.toString('utf8').trim();
  return sha.length > 0 ? sha : null;
}

async function isRootCommit(repoRoot: string, sha: string): Promise<boolean> {
  const run = await execGit(repoRoot, ['rev-list', '--parents', '-n', '1', sha]);
  if (run.code !== 0) throw new GitError(['rev-list', sha], run.code, run.stderr);
  return run.stdout.toString('utf8').trim().split(/\s+/).length === 1;
}

async function resolveSource(
  repoRoot: string,
  source: SessionSource,
): Promise<{ revs: string[]; headSha: string | null; baseRef: string }> {
  switch (source.type) {
    case 'working-tree': {
      const head = await revParse(repoRoot, 'HEAD');
      // No commits yet: diff the working tree against the empty tree so a
      // freshly `git add`ed file still shows up as added.
      return { revs: [head ?? EMPTY_TREE], headSha: head, baseRef: head ?? EMPTY_TREE };
    }
    case 'staged': {
      // git compares the index against the empty tree by itself on an unborn HEAD.
      const head = await revParse(repoRoot, 'HEAD');
      return { revs: ['--cached'], headSha: head, baseRef: head ?? EMPTY_TREE };
    }
    case 'commit': {
      const rev = requireRev(source.head, 'head', 'commit');
      const sha = await revParse(repoRoot, rev);
      if (sha === null) throw new Error(`cannot resolve commit '${rev}' in ${repoRoot}`);
      const base = (await isRootCommit(repoRoot, sha)) ? EMPTY_TREE : `${sha}^`;
      return { revs: [base, sha], headSha: sha, baseRef: base };
    }
    case 'range': {
      const base = requireRev(source.base, 'base', 'range');
      const head = requireRev(source.head, 'head', 'range');
      // Three-dot: merge-base semantics, like a GitHub PR.
      const merged = await execGit(repoRoot, ['merge-base', base, head]);
      if (merged.code !== 0)
        throw new GitError(['merge-base', base, head], merged.code, merged.stderr);
      const baseRef = merged.stdout.toString('utf8').trim();
      const headSha = await revParse(repoRoot, head);
      if (headSha === null) throw new Error(`cannot resolve commit '${head}' in ${repoRoot}`);
      return { revs: [baseRef, headSha], headSha, baseRef };
    }
    default: {
      const unknown: never = source.type;
      throw new Error(`unsupported source type: ${String(unknown)}`);
    }
  }
}

export async function computeDiff(repoRoot: string, source: SessionSource): Promise<DiffResult> {
  const { revs, headSha, baseRef } = await resolveSource(repoRoot, source);
  const args = ['-c', 'core.quotepath=off', 'diff', ...DIFF_ARGS, ...revs, '--'];
  const run = await execGit(repoRoot, args);
  if (run.code !== 0) throw new GitError(args, run.code, run.stderr);
  return {
    source,
    repoRoot,
    headSha,
    baseRef,
    ...(source.type === 'staged' ? { indexRevision: randomUUID() } : {}),
    files: parseUnifiedDiff(run.stdout.toString('utf8')),
  };
}

/**
 * Raw bytes of `path` at `ref`, or null when nothing is there — a missing path,
 * a path that only exists in the working tree, or a ref that doesn't resolve.
 * Anything else (not a repo, git missing, corrupt object) throws.
 */
export async function showFile(
  repoRoot: string,
  ref: string,
  path: string,
): Promise<Uint8Array | null> {
  if (ref.startsWith('-')) throw new Error(`ref must not start with '-': ${ref}`);
  const args = ['show', `${ref}:${path}`];
  const run = await execGit(repoRoot, args);
  if (run.code === 0) return run.stdout;
  if (run.code === 128 && MISSING_AT_REF.test(run.stderr)) return null;
  throw new GitError(args, run.code, run.stderr);
}

export function diffstat(diff: DiffResult): Diffstat {
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  for (const file of diff.files) {
    hunks += file.hunks.length;
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: diff.files.length, hunks, additions, deletions };
}

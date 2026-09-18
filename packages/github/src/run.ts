// The default runners: `gh` and `git` via execFile with an argv array — no
// shell, ever, because PR numbers and repo slugs come from session files. Both
// are built per repo root so the injectable runners stay `(args, stdin?)`,
// which is what makes every function in this package testable with a fake.

import { execFile, type ExecFileException } from 'node:child_process';
import { GhError } from './errors.ts';
import type { GhRun, RunGh, RunGit } from './types.ts';

/** A busy PR's comment list, paginated, is the biggest thing we read. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * LC_ALL pins gh's and git's messages to English so the error classifier still
 * works in a localised shell; the GH_* vars keep gh non-interactive — a prompt
 * or a pager on a pipe would hang an agent-driven run with no output at all.
 */
const ENV: NodeJS.ProcessEnv = {
  LC_ALL: 'C',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_PAGER: 'cat',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

function makeRunner(
  bin: string,
  repoRoot: string,
): (args: string[], stdin?: string) => Promise<GhRun> {
  return (args, stdin) =>
    new Promise<GhRun>((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX_BUFFER, env: { ...process.env, ...ENV } },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ code: error.code, stdout, stderr });
            return;
          }
          if (error.code === 'ENOENT') {
            // Classified as 'gh-missing' upstream, with an install hint.
            resolve({ code: 127, stdout: '', stderr: `${bin}: command not found` });
            return;
          }
          reject(
            new GhError(`${bin} ${args.join(' ')} could not run: ${error.message}`, {
              kind: 'failed',
              args,
              code: -1,
              stderr: stderr === '' ? error.message : stderr,
            }),
          );
        },
      );
      // `gh api --input -` reads stdin; anything else must still see EOF or it
      // can sit waiting on a pipe nobody writes to.
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin ?? '');
    });
}

export const makeRunGh = (repoRoot: string): RunGh => makeRunner('gh', repoRoot);
export const makeRunGit = (repoRoot: string): RunGit => makeRunner('git', repoRoot);

/** PR numbers reach argv; a negative one would be read as an option. */
export function requirePrNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`pr number must be a positive integer, got ${String(value)}`);
  }
  return value;
}

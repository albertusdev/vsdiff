// `vsdiff new`: scaffold a session directory and inventory the source diff so
// the agent can see every hunk id it may anchor against. Split out of main.ts
// because the MCP server (blueprint §7.3) runs the same scaffold and the same
// inventory — `vsdiff_new` and `vsdiff_diffstat` are this file, not a reimplementation.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import {
  computeDiff,
  diffstat,
  type DiffResult,
  type Diffstat,
  type FileStatus,
} from '@vsdiff/core';
import type { SessionSource } from '@vsdiff/schema';

export interface FileInventory {
  path: string;
  status: FileStatus;
  binary: boolean;
  hunks: number;
  hunkIds: string[];
}

/** What `vsdiff new --json` prints, minus the session it scaffolded. */
export interface DiffInventory {
  source: SessionSource;
  diffstat: Diffstat;
  files: FileInventory[];
}

export interface NewPayload extends DiffInventory {
  sessionPath: string;
}

export interface ScaffoldResult {
  payload: NewPayload;
  diff: DiffResult;
}

export interface NewOptions {
  repoRoot: string;
  source: SessionSource;
  title: string;
  /** Overridable so the session name is deterministic in tests. */
  today?: string;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'review'
  );
}

export function inventoryOf(diff: DiffResult): DiffInventory {
  return {
    source: diff.source,
    diffstat: diffstat(diff),
    files: diff.files.map((f) => ({
      path: f.path,
      status: f.status,
      binary: f.binary,
      hunks: f.hunks.length,
      hunkIds: f.hunks.map((h) => h.id),
    })),
  };
}

/** The diffstat + hunk inventory for a source, computed without writing anything. */
export async function inventorySource(
  repoRoot: string,
  source: SessionSource,
): Promise<DiffInventory> {
  return inventoryOf(await computeDiff(repoRoot, source));
}

/**
 * Writes `<repo>/.vsdiff/sessions/<date>-<slug>/session.json` (never over an
 * existing one) and returns the inventory the agent authors against.
 */
export async function scaffoldSession(options: NewOptions): Promise<ScaffoldResult> {
  const { repoRoot, source, title } = options;
  const diff = await computeDiff(repoRoot, source);

  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const dir = join(repoRoot, '.vsdiff', 'sessions', `${today}-${slugify(title)}`);
  const sessionPath = join(dir, 'session.json');
  const skeleton = {
    version: 1,
    kind: 'review',
    title,
    focus: '',
    source,
    chapters: [],
  };
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(skeleton, null, 2)}\n`, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      // stderr, so the MCP server's stdout stays pure JSON-RPC.
      process.stderr.write(`note: ${sessionPath} already exists — not overwriting\n`);
    },
  );

  return { payload: { sessionPath: resolve(sessionPath), ...inventoryOf(diff) }, diff };
}

function hunkListing(diff: DiffResult): string {
  return diff.files
    .map((file) => {
      const marker =
        file.status === 'added'
          ? 'A'
          : file.status === 'deleted'
            ? 'D'
            : file.status === 'renamed'
              ? 'R'
              : 'M';
      const ids = file.hunks.map((h) => `h${h.n}`).join(',');
      return `  ${marker} ${file.path}${file.binary ? ' (binary)' : ''} — ${file.hunks.length} hunks [${ids}]`;
    })
    .join('\n');
}

/** The human-readable `vsdiff new` output (the `--json` path prints `payload`). */
export function formatNewSummary(result: ScaffoldResult): string {
  const { payload, diff } = result;
  const stats = payload.diffstat;
  return (
    `Scaffolded ${payload.sessionPath}\n` +
    `Source: ${JSON.stringify(payload.source)}\n` +
    `Diffstat: ${stats.files} files, ${stats.hunks} hunks, +${stats.additions} -${stats.deletions}\n\n` +
    `Hunks to anchor against:\n${hunkListing(diff)}\n\n` +
    `Next: author chapters/stops into the session (see \`vsdiff guide\`), then \`vsdiff validate\`.\n`
  );
}

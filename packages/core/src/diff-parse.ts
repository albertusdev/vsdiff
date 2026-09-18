// Parser for `git diff` unified output → the DiffFile/DiffHunk contract in
// types.ts. Hunk ids are positional (`path:h<n>`), so file order and per-file
// hunk order are load-bearing: silently dropping a file would silently re-point
// every id after it. Anything this parser cannot account for throws with the
// offending lines quoted instead.

import type { DiffFile, DiffHunk, FileStatus } from './types.ts';

/** Thrown when the diff text cannot be parsed; `lines` quotes the offending input. */
export class DiffParseError extends Error {
  readonly lines: string[];

  constructor(message: string, lines: string[] = []) {
    const quoted = lines.map((line) => `  | ${line}`).join('\n');
    super(lines.length > 0 ? `${message}\n${quoted}` : message);
    this.name = 'DiffParseError';
    this.lines = lines;
  }
}

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = '/dev/null';

export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = splitLines(text);
  const files: DiffFile[] = [];

  let i = 0;
  while (i < lines.length && !isFileHeader(lines[i])) i++;
  if (i > 0) {
    const preamble = lines.slice(0, i).filter((line) => line.trim().length > 0);
    if (preamble.length > 0) {
      throw new DiffParseError(
        'diff does not start with a `diff --git` header',
        preamble.slice(0, 5),
      );
    }
  }

  while (i < lines.length) {
    const start = i;
    i++;
    while (i < lines.length && !isFileHeader(lines[i])) i++;
    files.push(parseFileBlock(lines.slice(start, i)));
  }
  return files;
}

const isFileHeader = (line: string | undefined): boolean =>
  line !== undefined && line.startsWith(FILE_HEADER);

/** git always terminates its lines, so re-adding `\n` per line is verbatim. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Side {
  devNull: boolean;
  path: string | null;
}

function parseFileBlock(block: string[]): DiffFile {
  const headerLine = block[0] ?? '';
  let oldSide: Side | null = null;
  let newSide: Side | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let copyTo: string | null = null;
  let isNew = false;
  let isDeleted = false;
  let binary = false;
  let hunkStart = block.length;

  for (let i = 1; i < block.length; i++) {
    const line = block[i] ?? '';
    if (HUNK_HEADER.test(line)) {
      hunkStart = i;
      break;
    }
    if (line.startsWith('--- ')) {
      oldSide = parseSide(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ')) {
      newSide = parseSide(line.slice(4), 'b/');
    } else if (line.startsWith('new file mode ')) {
      isNew = true;
    } else if (line.startsWith('deleted file mode ')) {
      isDeleted = true;
    } else if (line.startsWith('rename from ')) {
      renameFrom = unquotePath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      renameTo = unquotePath(line.slice('rename to '.length));
    } else if (line.startsWith('copy to ')) {
      // `--find-copies` is never passed, but `diff.renames = copies` in user
      // config can still produce these; a copy is a new file on the new side.
      copyTo = unquotePath(line.slice('copy to '.length));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    }
    // Everything else (index, similarity index, old/new mode, binary payload,
    // unknown extended headers) carries no information this contract needs.
  }

  const fallback = parseHeaderPaths(headerLine);
  const oldPath = renameFrom ?? oldSide?.path ?? fallback.old;
  const newPath = renameTo ?? copyTo ?? newSide?.path ?? fallback.new;

  let status: FileStatus;
  let path: string | null;
  if (isDeleted || newSide?.devNull === true) {
    status = 'deleted';
    path = oldPath;
  } else if (renameTo !== null) {
    status = 'renamed';
    path = newPath;
  } else if (isNew || copyTo !== null || oldSide?.devNull === true) {
    status = 'added';
    path = newPath;
  } else {
    status = 'modified';
    path = newPath ?? oldPath;
  }

  if (path === null || path.length === 0) {
    throw new DiffParseError(
      'cannot determine a path for this file record',
      block.slice(0, Math.min(block.length, hunkStart)),
    );
  }

  // Defense in depth: git only emits repo-relative paths, but these strings
  // reach vscode.Uri.joinPath and `git show <ref>:<path>` — a hostile diff
  // stream must not smuggle an escape through this parser.
  for (const candidate of [path, oldPath]) {
    if (candidate === null) continue;
    if (candidate.startsWith('/') || candidate.split('/').includes('..')) {
      throw new DiffParseError(
        `refusing a path that escapes the repository: ${candidate}`,
        block.slice(0, Math.min(block.length, hunkStart)),
      );
    }
  }

  if (binary) {
    // One synthetic hunk so a session can still anchor a stop at the file.
    return {
      path,
      ...(status === 'renamed' && oldPath !== null ? { oldPath } : {}),
      status,
      binary: true,
      additions: 0,
      deletions: 0,
      hunks: [
        {
          id: `${path}:h1`,
          n: 1,
          header: '',
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          additions: 0,
          deletions: 0,
          text: '',
        },
      ],
    };
  }

  const { hunks, additions, deletions } = parseHunks(block, hunkStart, path);
  return {
    path,
    ...(status === 'renamed' && oldPath !== null ? { oldPath } : {}),
    status,
    binary: false,
    additions,
    deletions,
    hunks,
  };
}

function parseHunks(
  block: string[],
  start: number,
  path: string,
): { hunks: DiffHunk[]; additions: number; deletions: number } {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let i = start;

  while (i < block.length) {
    const header = block[i] ?? '';
    const match = HUNK_HEADER.exec(header);
    if (match === null) {
      throw new DiffParseError(`expected a hunk header in ${path}`, [header]);
    }
    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    const n = hunks.length + 1;

    const body: string[] = [header];
    let oldSeen = 0;
    let newSeen = 0;
    let hunkAdditions = 0;
    let hunkDeletions = 0;
    i++;
    while (i < block.length) {
      const line = block[i] ?? '';
      // `\ No newline at end of file` annotates the line before it and counts
      // for neither side — including after the hunk's last counted line.
      if (line.startsWith('\\')) {
        body.push(line);
        i++;
        continue;
      }
      if (oldSeen >= oldLines && newSeen >= newLines) break;
      const marker = line.charAt(0);
      if (marker === '+') {
        newSeen++;
        hunkAdditions++;
      } else if (marker === '-') {
        oldSeen++;
        hunkDeletions++;
      } else if (marker === ' ' || marker === '') {
        // A context line for an empty line is a lone space; tolerate pipelines
        // that strip it.
        oldSeen++;
        newSeen++;
      } else {
        throw new DiffParseError(`unexpected line inside hunk ${path}:h${n}`, [header, line]);
      }
      body.push(line);
      i++;
    }
    if (oldSeen < oldLines || newSeen < newLines) {
      throw new DiffParseError(`hunk ${path}:h${n} ends early (saw -${oldSeen},+${newSeen})`, [
        header,
      ]);
    }

    additions += hunkAdditions;
    deletions += hunkDeletions;
    hunks.push({
      id: `${path}:h${n}`,
      n,
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      additions: hunkAdditions,
      deletions: hunkDeletions,
      text: body.map((line) => `${line}\n`).join(''),
    });
  }

  return { hunks, additions, deletions };
}

/** `--- a/path` / `+++ b/path`, with git's trailing tab on paths with spaces. */
function parseSide(raw: string, prefix: string): Side {
  const value = unquotePath(stripAtTab(raw));
  if (value === DEV_NULL) return { devNull: true, path: null };
  return { devNull: false, path: value.startsWith(prefix) ? value.slice(prefix.length) : value };
}

/** An unquoted git path never contains a tab, so the first tab ends the path. */
function stripAtTab(value: string): string {
  const tab = value.indexOf('\t');
  return tab === -1 ? value : value.slice(0, tab);
}

/**
 * `diff --git a/old b/new` — ambiguous when a path contains a space, so the
 * equal-paths split (every non-rename case) wins and rename/copy headers
 * override this anyway.
 */
function parseHeaderPaths(headerLine: string): { old: string | null; new: string | null } {
  const rest = headerLine.slice(FILE_HEADER.length);
  if (rest.length === 0) return { old: null, new: null };

  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest);
    if (end > 0) {
      const oldRaw = unquotePath(rest.slice(0, end + 1));
      const newRaw = unquotePath(rest.slice(end + 2));
      return { old: stripPrefix(oldRaw, 'a/'), new: stripPrefix(newRaw, 'b/') };
    }
  }

  let firstSplit: { old: string; new: string } | null = null;
  for (let i = 1; i + 1 < rest.length; i++) {
    if (rest[i] !== ' ' || rest[i + 1] !== 'b' || rest[i + 2] !== '/') continue;
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (!left.startsWith('a/')) continue;
    const candidate = { old: left.slice(2), new: unquotePath(right).slice(2) };
    if (candidate.old === candidate.new) return candidate;
    firstSplit ??= candidate;
  }
  if (firstSplit !== null) return firstSplit;
  return { old: null, new: null };
}

function findQuoteEnd(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === '"') return i;
  }
  return -1;
}

const stripPrefix = (value: string, prefix: string): string =>
  value.startsWith(prefix) ? value.slice(prefix.length) : value;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Undo git's C-style quoting. `core.quotepath=off` keeps UTF-8 unquoted, but
 * paths containing `"`, `\`, or control characters are quoted regardless.
 */
function unquotePath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) {
      for (const byte of ENCODER.encode(literal)) bytes.push(byte);
      literal = '';
    }
  };

  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (char !== '\\') {
      literal += char;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i++;
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      flush();
      bytes.push(simple);
      continue;
    }
    if (next >= '0' && next <= '7') {
      flush();
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8) & 0xff);
      i += 2;
      continue;
    }
    literal += next;
  }
  flush();
  return DECODER.decode(new Uint8Array(bytes));
}

const SIMPLE_ESCAPES: Record<string, number | undefined> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c,
};

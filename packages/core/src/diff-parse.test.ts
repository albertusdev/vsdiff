import { expect, test } from 'vitest';
import { DiffParseError, parseUnifiedDiff } from './diff-parse.ts';

/** Fixtures are verbatim `git diff` output; every line is newline-terminated. */
const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

test('empty diff parses to no files', () => {
  expect(parseUnifiedDiff('')).toEqual([]);
});

test('single-hunk modify: ids, line numbers, counts, verbatim text', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/src/a.ts b/src/a.ts',
      'index de98044..7be73ce 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ),
  );

  expect(file).toBeDefined();
  expect(file?.path).toBe('src/a.ts');
  expect(file?.status).toBe('modified');
  expect(file?.binary).toBe(false);
  expect(file?.oldPath).toBeUndefined();
  expect(file?.additions).toBe(1);
  expect(file?.deletions).toBe(1);
  expect(file?.hunks).toHaveLength(1);
  expect(file?.hunks[0]).toEqual({
    id: 'src/a.ts:h1',
    n: 1,
    header: '@@ -1,3 +1,3 @@',
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    additions: 1,
    deletions: 1,
    text: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
  });
});

test('multi-hunk modify numbers hunks 1..n with their own line ranges', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/src/multi.ts b/src/multi.ts',
      'index 1111111..2222222 100644',
      '--- a/src/multi.ts',
      '+++ b/src/multi.ts',
      '@@ -1,4 +1,5 @@ export function head()',
      ' one',
      '-two',
      '+TWO',
      '+two and a half',
      ' three',
      ' four',
      '@@ -20,3 +21,3 @@ export function tail()',
      ' twenty',
      '-twentyone',
      '+TWENTYONE',
      ' twentytwo',
    ),
  );

  expect(file?.hunks.map((hunk) => hunk.id)).toEqual(['src/multi.ts:h1', 'src/multi.ts:h2']);
  expect(file?.hunks.map((hunk) => hunk.n)).toEqual([1, 2]);
  expect(file?.hunks[0]?.header).toBe('@@ -1,4 +1,5 @@ export function head()');
  expect(file?.hunks[0]?.oldStart).toBe(1);
  expect(file?.hunks[0]?.oldLines).toBe(4);
  expect(file?.hunks[0]?.newStart).toBe(1);
  expect(file?.hunks[0]?.newLines).toBe(5);
  expect(file?.hunks[1]?.oldStart).toBe(20);
  expect(file?.hunks[1]?.newStart).toBe(21);
  expect(file?.hunks[1]?.text).toBe(
    '@@ -20,3 +21,3 @@ export function tail()\n twenty\n-twentyone\n+TWENTYONE\n twentytwo\n',
  );
  expect(file?.additions).toBe(3);
  expect(file?.deletions).toBe(2);
});

test('added file', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/added.txt b/added.txt',
      'new file mode 100644',
      'index 0000000..07f33c4',
      '--- /dev/null',
      '+++ b/added.txt',
      '@@ -0,0 +1,2 @@',
      '+new',
      '+file',
    ),
  );

  expect(file?.path).toBe('added.txt');
  expect(file?.status).toBe('added');
  expect(file?.additions).toBe(2);
  expect(file?.deletions).toBe(0);
  expect(file?.hunks[0]?.oldStart).toBe(0);
  expect(file?.hunks[0]?.oldLines).toBe(0);
});

test('deleted file keys on the old path', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index a290ced..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-del',
      '-me',
    ),
  );

  expect(file?.path).toBe('gone.txt');
  expect(file?.status).toBe('deleted');
  expect(file?.hunks[0]?.id).toBe('gone.txt:h1');
  expect(file?.additions).toBe(0);
  expect(file?.deletions).toBe(2);
});

test('pure rename has no hunks and zero counts', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/torename.txt b/renamed.txt',
      'similarity index 100%',
      'rename from torename.txt',
      'rename to renamed.txt',
    ),
  );

  expect(file?.path).toBe('renamed.txt');
  expect(file?.oldPath).toBe('torename.txt');
  expect(file?.status).toBe('renamed');
  expect(file?.hunks).toEqual([]);
  expect(file?.additions).toBe(0);
  expect(file?.deletions).toBe(0);
});

test('rename with edits keys hunks on the new path', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/seed.txt b/moved.txt',
      'similarity index 23%',
      'rename from seed.txt',
      'rename to moved.txt',
      'index e31de1f..4c9979d 100644',
      '--- a/seed.txt',
      '+++ b/moved.txt',
      '@@ -1 +1,4 @@',
      ' seed',
      '+more',
      '+lines',
      '+here',
    ),
  );

  expect(file?.path).toBe('moved.txt');
  expect(file?.oldPath).toBe('seed.txt');
  expect(file?.status).toBe('renamed');
  expect(file?.hunks[0]?.id).toBe('moved.txt:h1');
  // `@@ -1 +1,4 @@` — an omitted count means 1.
  expect(file?.hunks[0]?.oldLines).toBe(1);
  expect(file?.hunks[0]?.newLines).toBe(4);
  expect(file?.additions).toBe(3);
});

test('mode-only change is a modified file with no hunks', () => {
  const [file] = parseUnifiedDiff(
    diff('diff --git a/mode.txt b/mode.txt', 'old mode 100644', 'new mode 100755'),
  );

  expect(file?.path).toBe('mode.txt');
  expect(file?.status).toBe('modified');
  expect(file?.binary).toBe(false);
  expect(file?.hunks).toEqual([]);
});

test('binary "differ" form gets one synthetic zeroed hunk', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/blob.bin b/blob.bin',
      'index c94be36..e03d392 100644',
      'Binary files a/blob.bin and b/blob.bin differ',
    ),
  );

  expect(file?.path).toBe('blob.bin');
  expect(file?.status).toBe('modified');
  expect(file?.binary).toBe(true);
  expect(file?.additions).toBe(0);
  expect(file?.deletions).toBe(0);
  expect(file?.hunks).toEqual([
    {
      id: 'blob.bin:h1',
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
  ]);
});

test('GIT binary patch payload never leaks into hunks', () => {
  const files = parseUnifiedDiff(
    diff(
      'diff --git a/b.bin b/b.bin',
      'index 6d16585..4313027 100644',
      'GIT binary patch',
      'literal 8',
      'PcmZQzO3KVLVqgFO2E74p',
      '',
      'literal 6',
      'NcmZQzOv=n-000B30XqNy',
      '',
      'diff --git a/after.txt b/after.txt',
      'index 1111111..2222222 100644',
      '--- a/after.txt',
      '+++ b/after.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ),
  );

  expect(files).toHaveLength(2);
  expect(files[0]?.binary).toBe(true);
  expect(files[0]?.hunks[0]?.id).toBe('b.bin:h1');
  expect(files[0]?.hunks[0]?.text).toBe('');
  expect(files[1]?.path).toBe('after.txt');
  expect(files[1]?.hunks[0]?.id).toBe('after.txt:h1');
});

test('binary added file', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/img.png b/img.png',
      'new file mode 100644',
      'index 0000000..abcdef1',
      'Binary files /dev/null and b/img.png differ',
    ),
  );

  expect(file?.path).toBe('img.png');
  expect(file?.status).toBe('added');
  expect(file?.binary).toBe(true);
});

test('path with spaces survives the trailing tab git adds', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/space file.txt b/space file.txt',
      'index de98044..7be73ce 100644',
      '--- a/space file.txt\t',
      '+++ b/space file.txt\t',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ),
  );

  expect(file?.path).toBe('space file.txt');
  expect(file?.hunks[0]?.id).toBe('space file.txt:h1');
});

test('binary file with spaces falls back to the `diff --git` line', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/my pics/a b.png b/my pics/a b.png',
      'index c94be36..e03d392 100644',
      'Binary files a/my pics/a b.png and b/my pics/a b.png differ',
    ),
  );

  expect(file?.path).toBe('my pics/a b.png');
});

test('C-quoted paths are unescaped (quote, backslash, octal UTF-8)', () => {
  const quoted = parseUnifiedDiff(
    diff(
      'diff --git "a/sub/quo\\"te.txt" "b/sub/quo\\"te.txt"',
      'index bca70f3..73c52c3 100644',
      '--- "a/sub/quo\\"te.txt"',
      '+++ "b/sub/quo\\"te.txt"',
      '@@ -1 +1 @@',
      '-q',
      '+Q',
    ),
  );
  expect(quoted[0]?.path).toBe('sub/quo"te.txt');
  expect(quoted[0]?.hunks[0]?.id).toBe('sub/quo"te.txt:h1');

  // What `core.quotepath=on` (git's default) would emit for café.txt.
  const octal = parseUnifiedDiff(
    diff(
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      'index be761e0..d3b4b91 100644',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ),
  );
  expect(octal[0]?.path).toBe('café.txt');
});

test('quotepath=off leaves UTF-8 paths unquoted', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/café.txt b/café.txt',
      'index be761e0..d3b4b91 100644',
      '--- a/café.txt',
      '+++ b/café.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ),
  );
  expect(file?.path).toBe('café.txt');
});

test('no-newline markers stay in the text and count for neither side', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/nonl.txt b/nonl.txt',
      'index 1a9d148..7adf2e5 100644',
      '--- a/nonl.txt',
      '+++ b/nonl.txt',
      '@@ -1 +1 @@',
      '-nonl',
      '\\ No newline at end of file',
      '+nonl2',
      '\\ No newline at end of file',
    ),
  );

  expect(file?.additions).toBe(1);
  expect(file?.deletions).toBe(1);
  expect(file?.hunks).toHaveLength(1);
  expect(file?.hunks[0]?.text).toBe(
    '@@ -1 +1 @@\n-nonl\n\\ No newline at end of file\n+nonl2\n\\ No newline at end of file\n',
  );
});

test('diff-shaped content inside a hunk body is body, not structure', () => {
  const files = parseUnifiedDiff(
    diff(
      'diff --git a/patch.md b/patch.md',
      'index 1111111..2222222 100644',
      '--- a/patch.md',
      '+++ b/patch.md',
      '@@ -1,3 +1,5 @@',
      ' example:',
      '+diff --git a/x.ts b/x.ts',
      '+--- a/x.ts',
      '+++ b/x.ts',
      '-@@ -1 +1 @@',
      ' end',
    ),
  );

  expect(files).toHaveLength(1);
  expect(files[0]?.additions).toBe(3);
  expect(files[0]?.deletions).toBe(1);
  expect(files[0]?.hunks).toHaveLength(1);
});

test('empty context lines are tolerated', () => {
  const [file] = parseUnifiedDiff(
    diff(
      'diff --git a/blank.txt b/blank.txt',
      'index 1111111..2222222 100644',
      '--- a/blank.txt',
      '+++ b/blank.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '',
      '-b',
      '+B',
    ),
  );

  expect(file?.hunks).toHaveLength(1);
  expect(file?.additions).toBe(1);
  expect(file?.deletions).toBe(1);
});

test('unknown extended headers are skipped without losing the file', () => {
  const files = parseUnifiedDiff(
    diff(
      'diff --git a/x.ts b/x.ts',
      'index 1111111..2222222 100644',
      'brand new header from a future git',
      'dissimilarity index 40%',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ),
  );

  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe('x.ts');
  expect(files[0]?.hunks).toHaveLength(1);
});

test('files keep git order and each file restarts hunk numbering', () => {
  const files = parseUnifiedDiff(
    diff(
      'diff --git a/z.ts b/z.ts',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -1 +1 @@',
      '-z',
      '+Z',
      '@@ -9 +9 @@',
      '-y',
      '+Y',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
    ),
  );

  expect(files.map((file) => file.path)).toEqual(['z.ts', 'a.ts']);
  expect(files.flatMap((file) => file.hunks.map((hunk) => hunk.id))).toEqual([
    'z.ts:h1',
    'z.ts:h2',
    'a.ts:h1',
  ]);
});

test('throws with the offending line quoted instead of dropping a hunk', () => {
  const broken = diff(
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@',
    ' a',
    'garbage line with no marker',
    '+b',
  );

  expect(() => parseUnifiedDiff(broken)).toThrow(DiffParseError);
  expect(() => parseUnifiedDiff(broken)).toThrow(/garbage line with no marker/);
});

test('throws on a truncated hunk', () => {
  expect(() =>
    parseUnifiedDiff(
      diff('diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,9 +1,9 @@', ' a'),
    ),
  ).toThrow(/ends early/);
});

test('throws when a file record has no usable path', () => {
  expect(() => parseUnifiedDiff(diff('diff --git ', 'index 1111111..2222222 100644'))).toThrow(
    DiffParseError,
  );
});

test('throws on content before the first file header', () => {
  expect(() =>
    parseUnifiedDiff(diff('commit deadbeef', 'Author: nobody', 'diff --git a/x b/x')),
  ).toThrow(/does not start with/);
});

test('rejects paths that escape the repository (defense in depth)', () => {
  const evil = [
    'diff --git a/../escape.txt b/../escape.txt',
    'index 0000000..1111111 100644',
    '--- a/../escape.txt',
    '+++ b/../escape.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');
  expect(() => parseUnifiedDiff(evil)).toThrow(/escapes the repository/);
});

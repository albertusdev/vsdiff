import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  CONFIG_SCHEMA_URL,
  EDITOR_PRESETS,
  getConfigSchema,
  globalConfigPath,
  JsoncParseError,
  loadConfig,
  parseJsonc,
  persistDetectedEditor,
  repoConfigPath,
  resolveEditor,
} from './config.ts';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'vsdiff-config-'));
  tempRoots.push(root);
  return root;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

interface Sandbox {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  writeGlobal(text: string): void;
  writeRepo(text: string): void;
}

/** A throwaway XDG config home + repo root, wired together through `env`. */
function makeSandbox(): Sandbox {
  const root = makeTempRoot();
  const repoRoot = join(root, 'repo');
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(root, 'xdg'), PATH: '' };
  return {
    repoRoot,
    env,
    writeGlobal: (text) => write(globalConfigPath(env), text),
    writeRepo: (text) => write(repoConfigPath(repoRoot), text),
  };
}

/** A PATH entry holding the named binaries; `mode` 0o644 plants a non-executable one. */
function makeBinDir(bins: Record<string, number>): string {
  const dir = makeTempRoot();
  for (const [name, mode] of Object.entries(bins)) {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, mode);
  }
  return dir;
}

const EXEC = 0o755;
const NOT_EXEC = 0o644;

const pathEnv = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(delimiter) });

test('parseJsonc strips line comments, block comments and trailing commas', () => {
  const text = `{
  // which editor to open
  "editor": "cursor", /* inline */
  "session": { "gitignore": true, },
  "list": [1, 2,],
  /* a block
     spanning lines */
  "github": { "attribution": "none" },
}`;

  expect(parseJsonc(text)).toEqual({
    editor: 'cursor',
    session: { gitignore: true },
    list: [1, 2],
    github: { attribution: 'none' },
  });
});

test('parseJsonc leaves comment characters and commas inside strings alone', () => {
  const text = `{
  "url": "https://vsdiff.dev/schema", // a real comment
  "editorCommand": "ed // --goto {file}",
  "block": "a /* b */ c",
  "comma": "trailing,",
  "escaped": "a \\" // not a comment"
}`;

  expect(parseJsonc(text)).toEqual({
    url: 'https://vsdiff.dev/schema',
    editorCommand: 'ed // --goto {file}',
    block: 'a /* b */ c',
    comma: 'trailing,',
    escaped: 'a " // not a comment',
  });
});

test('parseJsonc handles CRLF files and comment-only documents', () => {
  expect(parseJsonc('{\r\n  // a comment\r\n  "editor": "vscode",\r\n}\r\n')).toEqual({
    editor: 'vscode',
  });
  expect(parseJsonc('// nothing configured yet\n/* still nothing */\n')).toBeUndefined();
  expect(parseJsonc('   ')).toBeUndefined();
});

test('parseJsonc reports line and column in the text as typed', () => {
  const text = '{\n  // a comment a naive strip would shift\n  "a": 1\n  "b": 2\n}';
  try {
    parseJsonc(text);
    expect.unreachable('expected a parse error');
  } catch (error) {
    expect(error).toBeInstanceOf(JsoncParseError);
    const parseError = error as JsoncParseError;
    expect(parseError.line).toBe(4);
    expect(parseError.column).toBe(3);
    expect(parseError.message).toContain("expected ',' or '}'");
    expect(parseError.message).toContain('line 4, column 3');
  }
});

test('parseJsonc reports an unterminated string at its opening quote', () => {
  try {
    parseJsonc('{\n  "editor": "curso\n}\n');
    expect.unreachable('expected a parse error');
  } catch (error) {
    expect(error).toBeInstanceOf(JsoncParseError);
    const parseError = error as JsoncParseError;
    expect(parseError.message).toContain('unterminated string');
    expect(parseError.line).toBe(2);
    expect(parseError.column).toBe(13);
  }
});

test('globalConfigPath prefers XDG_CONFIG_HOME and falls back to ~/.config', () => {
  expect(globalConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/dev' })).toBe(
    join('/xdg', 'vsdiff', 'config.jsonc'),
  );
  expect(globalConfigPath({ HOME: '/home/dev' })).toBe(
    join('/home/dev', '.config', 'vsdiff', 'config.jsonc'),
  );
  expect(globalConfigPath({ XDG_CONFIG_HOME: '  ', HOME: '/home/dev' })).toBe(
    join('/home/dev', '.config', 'vsdiff', 'config.jsonc'),
  );
});

test('loadConfig with neither file present returns an empty config and no warnings', async () => {
  const sandbox = makeSandbox();
  const loaded = await loadConfig(sandbox.repoRoot, sandbox.env);

  expect(loaded.config).toEqual({});
  expect(loaded.warnings).toEqual([]);
  expect(loaded.globalPath).toBe(globalConfigPath(sandbox.env));
  expect(loaded.repoPath).toBe(join(sandbox.repoRoot, '.vsdiff', 'config.jsonc'));
});

test('loadConfig overlays the repo file on the global one, one level deep', async () => {
  const sandbox = makeSandbox();
  sandbox.writeGlobal(`{
  "editor": "vscode",
  "editorCommand": "global-only-command",
  "github": { "attribution": "footer", "org": "acme" },
  "session": { "gitignore": true },
  "experimental": { "a": 1 },
  "globalOnly": "kept"
}`);
  sandbox.writeRepo(`{
  // this repo is reviewed in cursor
  "editor": "cursor",
  "github": { "attribution": "none" },
  "session": { "gitignore": false },
  "experimental": { "b": 2 },
  "repoOnly": true
}`);

  const { config, warnings } = await loadConfig(sandbox.repoRoot, sandbox.env);

  expect(warnings).toEqual([]);
  expect(config).toEqual({
    editor: 'cursor',
    editorCommand: 'global-only-command',
    // github/session merge per key…
    github: { attribution: 'none', org: 'acme' },
    session: { gitignore: false },
    // …every other object is replaced whole.
    experimental: { b: 2 },
    globalOnly: 'kept',
    repoOnly: true,
  });
});

test('loadConfig keeps the repo file when the global one is malformed', async () => {
  const sandbox = makeSandbox();
  sandbox.writeGlobal('{\n  "editor": "cursor",\n  "session": { \n}\n');
  sandbox.writeRepo('{ "editor": "windsurf" }');

  const { config, warnings, globalPath } = await loadConfig(sandbox.repoRoot, sandbox.env);

  expect(config).toEqual({ editor: 'windsurf' });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(globalPath);
  expect(warnings[0]).toContain('line');
  await expect(resolveEditor(config, sandbox.env)).resolves.toMatchObject({ kind: 'windsurf' });
});

test('loadConfig warns and skips a file whose top level is not an object', async () => {
  const sandbox = makeSandbox();
  sandbox.writeGlobal('{ "editor": "cursor" }');
  sandbox.writeRepo('["not", "a", "config"]');

  const { config, warnings, repoPath } = await loadConfig(sandbox.repoRoot, sandbox.env);

  expect(config).toEqual({ editor: 'cursor' });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(repoPath);
  expect(warnings[0]).toContain('an array');
});

test('editor presets carry bin, scheme and the shared upstream CLI argv', () => {
  expect(EDITOR_PRESETS.vscode).toMatchObject({ kind: 'vscode', bin: 'code', uriScheme: 'vscode' });
  expect(EDITOR_PRESETS.cursor).toMatchObject({
    kind: 'cursor',
    bin: 'cursor',
    uriScheme: 'cursor',
  });
  expect(EDITOR_PRESETS.windsurf).toMatchObject({
    kind: 'windsurf',
    bin: 'windsurf',
    uriScheme: 'windsurf',
  });

  expect(EDITOR_PRESETS.cursor.argv({ dir: '/repo' })).toEqual(['/repo']);
  expect(EDITOR_PRESETS.cursor.argv({ dir: '/repo', file: '/repo/src/a.ts', line: 12 })).toEqual([
    '/repo',
    '--goto',
    '/repo/src/a.ts:12',
  ]);
  expect(EDITOR_PRESETS.cursor.argv({ dir: '/repo', file: '/repo/src/a.ts' })).toEqual([
    '/repo',
    '--goto',
    '/repo/src/a.ts',
  ]);
});

test('resolveEditor: VSDIFF_EDITOR beats config, config beats detection', async () => {
  const bins = makeBinDir({ code: EXEC, cursor: EXEC, windsurf: EXEC });
  const env = pathEnv(bins);

  await expect(
    resolveEditor({ editor: 'windsurf' }, { ...env, VSDIFF_EDITOR: 'cursor' }),
  ).resolves.toMatchObject({ kind: 'cursor', bin: 'cursor' });
  await expect(resolveEditor({ editor: 'windsurf' }, env)).resolves.toMatchObject({
    kind: 'windsurf',
  });
  await expect(resolveEditor({}, env)).resolves.toMatchObject({ kind: 'vscode', bin: 'code' });
  // `auto` on either side means "detect", whatever the other side says.
  await expect(
    resolveEditor({ editor: 'windsurf' }, { ...env, VSDIFF_EDITOR: 'auto' }),
  ).resolves.toMatchObject({ kind: 'vscode' });
  await expect(resolveEditor({ editor: 'auto' }, env)).resolves.toMatchObject({ kind: 'vscode' });
});

test('resolveEditor detects in table order and skips non-executable files', async () => {
  const first = makeBinDir({ cursor: EXEC });
  const second = makeBinDir({ code: EXEC, windsurf: EXEC });

  // `code` wins even from a later PATH entry: the preset table is the order.
  await expect(resolveEditor({}, pathEnv(first, second))).resolves.toMatchObject({
    kind: 'vscode',
  });

  const unusable = makeBinDir({ code: NOT_EXEC, cursor: EXEC });
  await expect(resolveEditor({}, pathEnv(unusable))).resolves.toMatchObject({ kind: 'cursor' });

  const empty = makeBinDir({});
  await expect(resolveEditor({}, pathEnv(empty))).resolves.toBeNull();
  await expect(resolveEditor({}, {})).resolves.toBeNull();
});

test('resolveEditor builds a custom command without a shell', async () => {
  const editor = await resolveEditor(
    {
      editor: 'custom',
      editorCommand: 'my-editor --new "Some Editor.app" {dir} --goto {file}:{line}',
    },
    {},
  );

  expect(editor).not.toBeNull();
  expect(editor).toMatchObject({ kind: 'custom', bin: 'my-editor', uriScheme: null });
  expect(editor?.argv({ dir: '/repo', file: 'src/a.ts', line: 12 })).toEqual([
    '--new',
    'Some Editor.app',
    '/repo',
    '--goto',
    'src/a.ts:12',
  ]);
  // No file to show: the fused `{file}:{line}` token drops out entirely, but a
  // flag of its own keeps its place — templates should fuse flag and value.
  expect(editor?.argv({ dir: '/repo' })).toEqual(['--new', 'Some Editor.app', '/repo', '--goto']);
});

test('resolveEditor drops custom arguments whose placeholders have no value', async () => {
  const editor = await resolveEditor(
    { editor: 'custom', editorCommand: 'ed {dir} {file} --line={line}' },
    {},
  );

  expect(editor?.argv({ dir: '/repo', file: 'a.ts', line: 3 })).toEqual([
    '/repo',
    'a.ts',
    '--line=3',
  ]);
  expect(editor?.argv({ dir: '/repo' })).toEqual(['/repo']);
  expect(editor?.argv({ dir: '/repo', file: 'a.ts' })).toEqual(['/repo', 'a.ts']);
});

test('resolveEditor falls back to detection when custom has no usable command', async () => {
  const bins = makeBinDir({ cursor: EXEC });

  await expect(
    resolveEditor({ editor: 'custom', editorCommand: '   ' }, pathEnv(bins)),
  ).resolves.toMatchObject({ kind: 'cursor' });
  await expect(resolveEditor({ editor: 'custom' }, pathEnv(bins))).resolves.toMatchObject({
    kind: 'cursor',
  });
  // An unrecognised name is ignored the same way rather than failing the run.
  await expect(
    resolveEditor({ editor: 'zed' as never }, { ...pathEnv(bins), VSDIFF_EDITOR: 'emacs' }),
  ).resolves.toMatchObject({ kind: 'cursor' });
});

test('VSDIFF_EDITOR=custom uses the configured template', async () => {
  const editor = await resolveEditor(
    { editor: 'vscode', editorCommand: 'ed {dir}' },
    { VSDIFF_EDITOR: 'custom' },
  );

  expect(editor).toMatchObject({ kind: 'custom', bin: 'ed' });
  expect(editor?.argv({ dir: '/repo' })).toEqual(['/repo']);
});

test('persistDetectedEditor writes a first-run config that loadConfig then reads', async () => {
  const sandbox = makeSandbox();
  const globalPath = globalConfigPath(sandbox.env);

  await persistDetectedEditor(globalPath, 'cursor');

  expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({
    $schema: CONFIG_SCHEMA_URL,
    editor: 'cursor',
  });
  const { config, warnings } = await loadConfig(sandbox.repoRoot, sandbox.env);
  expect(warnings).toEqual([]);
  expect(config.editor).toBe('cursor');
});

test('persistDetectedEditor never rewrites an existing file', async () => {
  const sandbox = makeSandbox();
  const globalPath = globalConfigPath(sandbox.env);
  const handEdited = '{\n  // chosen by hand\n  "editor": "windsurf",\n}\n';
  write(globalPath, handEdited);
  const before = readFileSync(globalPath);

  await persistDetectedEditor(globalPath, 'cursor');
  await persistDetectedEditor(globalPath, 'vscode');

  expect(readFileSync(globalPath).equals(before)).toBe(true);
  expect(readFileSync(globalPath, 'utf8')).toBe(handEdited);
});

test('getConfigSchema returns a fresh copy of the published schema', () => {
  const schema = getConfigSchema() as Record<string, unknown>;

  expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
  expect(schema.additionalProperties).toBe(true);
  const properties = schema.properties as Record<string, { enum?: string[] }>;
  expect(properties.editor?.enum).toEqual([
    'auto',
    'vscode',
    'cursor',
    'windsurf',
    'custom',
    'web',
  ]);

  delete schema.properties;
  expect((getConfigSchema() as Record<string, unknown>).properties).toBeDefined();
});

test('resolveEditor: web resolves from config and env without touching presets', async () => {
  const fromConfig = await resolveEditor({ editor: 'web' }, { PATH: '' });
  expect(fromConfig).toMatchObject({ kind: 'web', via: 'config', bin: 'code', uriScheme: null });
  const fromEnv = await resolveEditor({ editor: 'vscode' }, { VSDIFF_EDITOR: 'web', PATH: '' });
  expect(fromEnv).toMatchObject({ kind: 'web', via: 'env' });
  expect(fromEnv?.argv({ dir: '/x' })).toEqual([]);
});

test('repo config cannot select a custom executable or redirect server storage', async () => {
  const sandbox = makeSandbox();
  sandbox.writeGlobal(JSON.stringify({ editor: 'vscode', web: { dataDir: '/user-owned' } }));
  sandbox.writeRepo(
    JSON.stringify({
      editor: 'custom',
      editorCommand: 'sh -c malicious',
      web: { dataDir: '/outside', port: 22 },
    }),
  );
  const { config, warnings } = await loadConfig(sandbox.repoRoot, sandbox.env);
  expect(config.editor).toBe('vscode');
  expect(config.editorCommand).toBeUndefined();
  expect(config.web).toEqual({ dataDir: '/user-owned' });
  expect(warnings).toHaveLength(3);
});

// Config subsystem (blueprint §7.4): a global `~/.config/vsdiff/config.jsonc`
// overlaid by a per-repo `.vsdiff/config.jsonc`, plus the editor preset table
// that turns a choice into a CLI binary, a deep-link scheme and an argv.
//
// Two constraints shape everything here. A hand-edited file must never brick a
// run: a malformed config is skipped with a warning, never thrown at the user
// mid-verb. And unknown keys survive a load untouched — several vsdiff versions
// (CLI, extension) read the same file, so nothing here may normalise it away.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import schema from './vsdiff-config.schema.json' with { type: 'json' };

/** Which editor `vsdiff open` launches. `auto` detects, `custom` uses
 *  `editorCommand`, `web` opens a browser tab on a local serve-web daemon. */
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'custom' | 'web';

/** The choices backed by a preset row in `EDITOR_PRESETS`. */
export type EditorPresetName = Exclude<EditorChoice, 'auto' | 'custom' | 'web'>;

/** Settings for the `web` editor target (the shared serve-web daemon). */
export interface WebConfig {
  port?: number;
  dataDir?: string;
  [extra: string]: unknown;
}

/** The config file's shape. Every field is optional and unknown keys are kept. */
export interface VsdiffConfig {
  editor?: EditorChoice;
  editorCommand?: string;
  web?: WebConfig;
  github?: { attribution?: 'footer' | 'none' };
  session?: { gitignore?: boolean };
  [extra: string]: unknown;
}

/** What an editor is being asked to show: a folder, optionally a file and line in it. */
export interface EditorTarget {
  dir: string;
  file?: string;
  line?: number;
}

export interface ResolvedEditor {
  /** How this editor was chosen — 'detected' is the only value safe to persist. */
  via?: 'env' | 'config' | 'detected';
  kind: EditorPresetName | 'custom' | 'web';
  /** The command to spawn. Presets carry the bare name; PATH lookup is spawn's job. */
  bin: string;
  /** Deep-link scheme (`vscode`, `cursor`, …), null for a custom command. */
  uriScheme: string | null;
  /** Arguments for `bin` — argv[0] is not included. */
  argv(target: EditorTarget): string[];
}

export interface LoadedConfig {
  config: VsdiffConfig;
  globalPath: string;
  repoPath: string;
  /** One line per file that could not be read or parsed; empty on a clean load. */
  warnings: string[];
}

/** The `$schema` value written into a config file vsdiff creates itself. */
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/albertusdev/vsdiff/main/packages/core/src/vsdiff-config.schema.json';

const CONFIG_FILE = 'config.jsonc';

/** Env var overriding the configured editor for one invocation (§7.4). */
const EDITOR_ENV = 'VSDIFF_EDITOR';

function presetEditor(
  kind: EditorPresetName,
  bin: string,
  uriScheme: string,
): Readonly<ResolvedEditor> {
  return Object.freeze({
    kind,
    bin,
    uriScheme,
    // Every fork inherits upstream's CLI surface: `<bin> <dir>` opens the folder,
    // `--goto file:line` reveals a line inside it.
    argv(target: EditorTarget): string[] {
      const argv = [target.dir];
      if (target.file !== undefined && target.file !== '') {
        const at = target.line === undefined ? target.file : `${target.file}:${target.line}`;
        argv.push('--goto', at);
      }
      return argv;
    },
  });
}

/**
 * The three-value table from §7.4 — CLI binary, deep-link URI scheme, argv.
 * Insertion order is also the auto-detect order (code, then cursor, then windsurf).
 */
export const EDITOR_PRESETS: Readonly<Record<EditorPresetName, ResolvedEditor>> = Object.freeze({
  vscode: presetEditor('vscode', 'code', 'vscode'),
  cursor: presetEditor('cursor', 'cursor', 'cursor'),
  windsurf: presetEditor('windsurf', 'windsurf', 'windsurf'),
});

/** Thrown by `parseJsonc`. `line`/`column` are 1-based positions in the text as typed. */
export class JsoncParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'JsoncParseError';
    this.line = line;
    this.column = column;
  }
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * Blanks out `//` and `/* *\/` comments. Stripped characters become spaces
 * (newlines survive) rather than being removed, so every offset in the result
 * still addresses the original text and a parse error can be reported at the
 * line and column the user actually typed. The walk tracks string literals, so
 * a `//` inside a JSON string — a URL, say — is left alone.
 */
function blankComments(text: string): string {
  const out = text.split('');
  const blank = (index: number): void => {
    if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' ';
  };

  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        // The escaped character may be a quote; stepping over both keeps the walk honest.
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Blanks a comma that only separates a value from its closing `]`/`}`. Runs on
 *  comment-free text, so it cannot trip over a comma inside a comment; string
 *  literals are still tracked, so `"a,"` survives. */
function blankTrailingCommas(text: string): string {
  const out = text.split('');
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== ',') continue;
    let next = i + 1;
    while (isWhitespace(text[next])) next += 1;
    if (text[next] === ']' || text[next] === '}') out[i] = ' ';
  }
  return out.join('');
}

interface JsonFault {
  message: string;
  offset: number;
}

/**
 * Finds the first offending offset in text `JSON.parse` has already rejected.
 * V8 carries a position on some parse errors and only a text snippet on others,
 * and the wording shifts between Node versions; walking the grammar here keeps
 * the reported line/column exact and the message stable. Returns null when the
 * scan finds nothing — then the caller keeps V8's own message.
 */
function locateJsonFault(text: string): JsonFault | null {
  let i = 0;
  const skipWhitespace = (): void => {
    while (isWhitespace(text[i])) i += 1;
  };
  const fault = (message: string): JsonFault => ({ message, offset: i });

  const string = (): JsonFault | null => {
    const start = i;
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '\n') break;
      i += 1;
      if (ch === '"') return null;
    }
    i = start;
    return fault('unterminated string');
  };

  const number = (): JsonFault | null => {
    if (text[i] === '-') i += 1;
    while (isDigit(text[i])) i += 1;
    if (text[i] === '.') {
      i += 1;
      while (isDigit(text[i])) i += 1;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      while (isDigit(text[i])) i += 1;
    }
    return null;
  };

  const value = (): JsonFault | null => {
    skipWhitespace();
    const ch = text[i];
    if (ch === undefined) return fault('unexpected end of input, expected a value');
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"') return string();
    if (ch === '-' || isDigit(ch)) return number();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return null;
      }
    }
    return fault(`unexpected ${JSON.stringify(ch)}, expected a value`);
  };

  function object(): JsonFault | null {
    i += 1;
    skipWhitespace();
    if (text[i] === '}') {
      i += 1;
      return null;
    }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') return fault('expected a property name in double quotes');
      const key = string();
      if (key !== null) return key;
      skipWhitespace();
      if (text[i] !== ':') return fault("expected ':' after a property name");
      i += 1;
      const entry = value();
      if (entry !== null) return entry;
      skipWhitespace();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return null;
      }
      return fault("expected ',' or '}' after a property value");
    }
  }

  function array(): JsonFault | null {
    i += 1;
    skipWhitespace();
    if (text[i] === ']') {
      i += 1;
      return null;
    }
    for (;;) {
      const entry = value();
      if (entry !== null) return entry;
      skipWhitespace();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return null;
      }
      return fault("expected ',' or ']' after an array element");
    }
  }

  const root = value();
  if (root !== null) return root;
  skipWhitespace();
  if (i < text.length) return fault('unexpected content after the top-level value');
  return null;
}

const V8_POSITION = /at position (\d+)/;

/** V8's own offset, for the rare failure the grammar walk above accepts (an
 *  invalid escape, a raw control character in a string). */
function v8Offset(message: string, fallback: number): number {
  const digits = V8_POSITION.exec(message)?.[1];
  return digits === undefined ? fallback : Number(digits);
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * JSONC → value. Comments and trailing commas are stripped without disturbing
 * string literals that contain `//`, `/*` or a comma. A document that holds
 * nothing but whitespace and comments parses to `undefined` (VS Code's own JSONC
 * reader does the same); anything else that is not valid JSON throws a
 * `JsoncParseError` carrying the line and column in the original text.
 */
export function parseJsonc(text: string): unknown {
  const json = blankTrailingCommas(blankComments(text));
  if (json.trim() === '') return undefined;
  try {
    return JSON.parse(json);
  } catch (error) {
    const raw = (error as Error).message;
    const fault = locateJsonFault(json);
    const message = fault?.message ?? raw.split(' in JSON at position')[0] ?? raw;
    const offset = fault?.offset ?? v8Offset(raw, json.length);
    const { line, column } = positionOf(json, offset);
    throw new JsoncParseError(message, line, column);
  }
}

/** `$XDG_CONFIG_HOME/vsdiff/config.jsonc`, falling back to `~/.config`. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.trim() !== '' ? xdg : join(env.HOME ?? homedir(), '.config');
  return join(base, 'vsdiff', CONFIG_FILE);
}

/** `<repoRoot>/.vsdiff/config.jsonc`. */
export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, '.vsdiff', CONFIG_FILE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys whose object value merges one level deep; every other key is replaced whole. */
const DEEP_KEYS: string[] = ['github', 'session', 'web'];

function mergeConfig(base: VsdiffConfig, over: VsdiffConfig): VsdiffConfig {
  const merged: VsdiffConfig = { ...base, ...over };
  for (const key of DEEP_KEYS) {
    const left = base[key];
    const right = over[key];
    if (isPlainObject(left) && isPlainObject(right)) merged[key] = { ...left, ...right };
  }
  return merged;
}

function describe(value: unknown): string {
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

async function readConfigFile(path: string, warnings: string[]): Promise<VsdiffConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    warnings.push(`${path}: ${(error as Error).message}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    warnings.push(`${path}: ${(error as Error).message}`);
    return {};
  }

  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) {
    warnings.push(`${path}: expected a JSON object, found ${describe(parsed)}`);
    return {};
  }
  return parsed as VsdiffConfig;
}

/**
 * Reads both config files and overlays the repo's onto the global one. A file
 * that is missing contributes `{}`; a file that cannot be read or parsed also
 * contributes `{}` but names itself in `warnings`, so one bad brace never costs
 * the user the other file's settings — or the run.
 */
export async function loadConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const globalPath = globalConfigPath(env);
  const repoPath = repoConfigPath(repoRoot);
  const warnings: string[] = [];
  const global = await readConfigFile(globalPath, warnings);
  const repo = await readConfigFile(repoPath, warnings);
  // A cloned repository must not choose a program to execute or where the
  // local editor server writes. These machine settings belong to the user.
  for (const key of ['editorCommand', 'web'] as const) {
    if (repo[key] !== undefined) {
      warnings.push(`${repoPath}: ${key} is a user setting; configure it in ${globalPath}`);
      delete repo[key];
    }
  }
  if (repo.editor === 'custom') {
    warnings.push(`${repoPath}: custom editors must be selected in ${globalPath}`);
    delete repo.editor;
  }
  return { config: mergeConfig(global, repo), globalPath, repoPath, warnings };
}

/**
 * Splits a command template into argv tokens: whitespace separates, double
 * quotes group (and may open mid-token, so `--flag="a b"` stays one token).
 * There is no shell and no escape processing — the tokens go straight to spawn.
 */
function tokenizeCommand(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;

  for (const ch of template) {
    if (quoted) {
      if (ch === '"') quoted = false;
      else current += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (isWhitespace(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const PLACEHOLDER = /\{(dir|file|line)\}/g;

function placeholderValue(name: string, target: EditorTarget): string {
  if (name === 'dir') return target.dir;
  if (name === 'file') return target.file ?? '';
  return target.line === undefined ? '' : String(target.line);
}

/**
 * Substitutes `{dir}`/`{file}`/`{line}` inside one token. A token whose
 * placeholders all come up empty is dropped (null): `{file}` alone disappears
 * on a folder-only open, and so does a fused `{file}:{line}` — a flag in front
 * of it does not, so templates should keep the flag and its value in one token
 * (`--goto={file}`) when the target may lack a file.
 */
function substitute(token: string, target: EditorTarget): string | null {
  let placeholders = 0;
  let filled = 0;
  const value = token.replace(PLACEHOLDER, (_match, name: string) => {
    placeholders += 1;
    const replacement = placeholderValue(name, target);
    if (replacement !== '') filled += 1;
    return replacement;
  });
  return placeholders > 0 && filled === 0 ? null : value;
}

function customEditor(template: unknown): ResolvedEditor | null {
  if (typeof template !== 'string') return null;
  const tokens = tokenizeCommand(template);
  const [bin, ...rest] = tokens;
  if (bin === undefined || bin === '') return null;
  return Object.freeze({
    kind: 'custom' as const,
    bin,
    uriScheme: null,
    argv(target: EditorTarget): string[] {
      const argv: string[] = [];
      for (const token of rest) {
        const value = substitute(token, target);
        if (value !== null) argv.push(value);
      }
      return argv;
    },
  });
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    // stat, not access: X_OK is true for anything when the process runs as root.
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** First preset binary found on PATH, in table order. */
async function detectEditor(env: NodeJS.ProcessEnv): Promise<ResolvedEditor | null> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const preset of Object.values(EDITOR_PRESETS)) {
    for (const dir of dirs) {
      if (await isExecutableFile(join(dir, preset.bin))) return preset;
    }
  }
  return null;
}

function asChoice(value: unknown): EditorChoice | null {
  if (typeof value !== 'string') return null;
  const choice = value.trim().toLowerCase();
  return choice === 'auto' ||
    choice === 'vscode' ||
    choice === 'cursor' ||
    choice === 'windsurf' ||
    choice === 'custom' ||
    choice === 'web'
    ? choice
    : null;
}

/**
 * Resolves the editor to launch: `VSDIFF_EDITOR` wins, then `editor` in the
 * config, then detection. Anything unrecognised — an unknown name, `custom`
 * without a usable `editorCommand` — falls through to the next step rather than
 * failing the run, so a stale config still opens something. Returns null only
 * when no editor was configured and none is on PATH.
 */
export async function resolveEditor(
  config: VsdiffConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedEditor | null> {
  const envChoice = asChoice(env[EDITOR_ENV]);
  const choice = envChoice ?? asChoice(config.editor);
  const via: ResolvedEditor['via'] =
    envChoice !== null ? 'env' : choice !== null ? 'config' : 'detected';
  if (choice === 'web') {
    // Not a preset: the launcher runs the serve-web flow instead of spawning
    // `bin` on the target. `bin` names the host CLI that serves the web UI.
    return Object.freeze({
      via,
      kind: 'web' as const,
      bin: 'code',
      uriScheme: null,
      argv: () => [],
    });
  }
  if (choice === 'custom') {
    const custom = customEditor(config.editorCommand);
    if (custom !== null) return { ...custom, via };
  } else if (choice !== null && choice !== 'auto') {
    return { ...EDITOR_PRESETS[choice], via };
  }
  const detected = await detectEditor(env);
  // A choice that fell through (typo, custom without a template) still counts
  // as chosen — the fallback detection must not be persisted as first-run.
  return detected === null ? null : { ...detected, via: choice !== null ? via : 'detected' };
}

/**
 * First-run persistence (codiff's pattern): records the detected editor in a
 * fresh global config. The `wx` flag makes "only if absent" a single atomic
 * step, so a file the user has already hand-edited is never rewritten — not
 * even by two vsdiff processes starting at once.
 */
export async function persistDetectedEditor(globalPath: string, editor: string): Promise<void> {
  const body = `${JSON.stringify({ $schema: CONFIG_SCHEMA_URL, editor }, null, 2)}\n`;
  await mkdir(dirname(globalPath), { recursive: true });
  try {
    await writeFile(globalPath, body, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
}

/** A deep copy of the published config schema — callers print or serve it. */
export function getConfigSchema(): object {
  return structuredClone(schema) as object;
}

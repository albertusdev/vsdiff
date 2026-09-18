// Best-effort editor launch through the §7.4 presets: VSDIFF_EDITOR env >
// config.editor > auto-detect (code, cursor, windsurf). Always optional: a
// failed spawn never fails the verb, and VSDIFF_NO_LAUNCH=1 turns it off so
// test runs and agent harnesses never open a window. First successful
// auto-detection is persisted to the global config (write-once).

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { globalConfigPath, loadConfig, persistDetectedEditor, resolveEditor } from '@vsdiff/core';
import { VERSION } from './version.ts';
import { ensureWeb, openBrowser } from './web-launch.ts';

export type Env = Record<string, string | undefined>;

export function launchDisabled(env: Env = process.env): boolean {
  const flag = env.VSDIFF_NO_LAUNCH;
  return flag !== undefined && flag !== '' && flag !== '0';
}

/** First executable named `bin` on PATH, or null. */
export function findOnPath(bin: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Opens the repo in the user's editor, detached so the CLI can go on to block
 * on `result.json`. Returns the binary launched, or null when nothing was.
 */
export async function launchEditor(
  repoRoot: string,
  env: Env = process.env,
): Promise<string | null> {
  if (launchDisabled(env)) return null;
  const { config, warnings } = await loadConfig(repoRoot, env as NodeJS.ProcessEnv);
  for (const warning of warnings) process.stderr.write(`vsdiff: ${warning}\n`);
  const editor = await resolveEditor(config, env as NodeJS.ProcessEnv);
  if (editor === null) return null;

  if (editor.kind === 'web') {
    const result = await ensureWeb(config, repoRoot, VERSION, env);
    if ('error' in result) {
      process.stderr.write(`vsdiff web: ${result.error}\n`);
      return null;
    }
    for (const warning of result.warnings) process.stderr.write(`vsdiff web: ${warning}\n`);
    openBrowser(result.url, env);
    process.stderr.write(`vsdiff web: ${result.url}\n`);
    return 'serve-web';
  }

  // Persist only genuine detections — resolveEditor already made this call
  // (dogfood finding: re-deriving precedence here is how a bug got in).
  if (editor.via === 'detected') {
    await persistDetectedEditor(globalConfigPath(env as NodeJS.ProcessEnv), editor.kind).catch(
      () => {},
    );
  }

  try {
    const child = spawn(editor.bin, editor.argv({ dir: repoRoot }), {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      // The editor not starting is never fatal to the handoff.
    });
    child.unref();
    return editor.bin;
  } catch {
    return null;
  }
}

// `vsdiff config` — show where config comes from and what it resolved to.

import { existsSync } from 'node:fs';
import { loadConfig, resolveEditor, type ResolvedEditor, type VsdiffConfig } from '@vsdiff/core';

export interface ConfigReport {
  globalPath: string;
  globalExists: boolean;
  repoPath: string;
  repoExists: boolean;
  warnings: string[];
  config: VsdiffConfig;
  editor: { kind: ResolvedEditor['kind']; bin: string; uriScheme: string | null } | null;
}

export async function configReport(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigReport> {
  const { config, globalPath, repoPath, warnings } = await loadConfig(repoRoot, env);
  const editor = await resolveEditor(config, env);
  return {
    globalPath,
    globalExists: existsSync(globalPath),
    repoPath,
    repoExists: existsSync(repoPath),
    warnings: warnings ?? [],
    config,
    editor: editor ? { kind: editor.kind, bin: editor.bin, uriScheme: editor.uriScheme } : null,
  };
}

export function renderConfigReport(report: ConfigReport): string {
  const mark = (exists: boolean) => (exists ? '' : ' (missing)');
  const lines = [
    `global: ${report.globalPath}${mark(report.globalExists)}`,
    `repo:   ${report.repoPath}${mark(report.repoExists)}`,
    report.editor
      ? `editor: ${report.editor.kind} — bin \`${report.editor.bin}\`${report.editor.uriScheme ? ` · ${report.editor.uriScheme}://` : ''}`
      : 'editor: none found (install VS Code/Cursor/Windsurf, or set "editor" in the config)',
  ];
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  lines.push(`merged: ${JSON.stringify(report.config, null, 2)}`);
  return `${lines.join('\n')}\n`;
}

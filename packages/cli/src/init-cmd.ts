// `vsdiff init` — set a repo up for guided reviews: gitignore the session dir,
// drop the MCP registration, and (--skill claude) install the packaged skill.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@vsdiff/core';

/** The packaged skill ships next to the CLI in the repo/package layout. */
function packagedSkillPath(): string {
  return fileURLToPath(new URL('../../../skills/claude/vsdiff/SKILL.md', import.meta.url));
}

export interface InitResult {
  actions: string[];
}

export async function runInit(repoRoot: string, options: { skill?: string }): Promise<InitResult> {
  const actions: string[] = [];
  const { config } = await loadConfig(repoRoot);

  // .gitignore: sessions are ephemeral by default (blueprint Q2 default) —
  // but only sessions: .vsdiff/config.jsonc is a committable team file.
  // session.gitignore: false opts a team into committing sessions too.
  if (config.session?.gitignore !== false) {
    const gitignorePath = join(repoRoot, '.gitignore');
    const gitignore = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : '';
    const covered = gitignore
      .split('\n')
      .some((line) => ['.vsdiff', '.vsdiff/sessions'].includes(line.trim().replace(/\/$/, '')));
    if (!covered) {
      await writeFile(
        gitignorePath,
        `${gitignore}${gitignore.endsWith('\n') || gitignore === '' ? '' : '\n'}.vsdiff/sessions/\n`,
      );
      actions.push(`added .vsdiff/sessions/ to ${gitignorePath}`);
    }
  }

  // MCP registration for tool-preferring harnesses; never clobber an existing file.
  const mcpPath = join(repoRoot, '.mcp.json');
  if (!existsSync(mcpPath)) {
    await writeFile(
      mcpPath,
      `${JSON.stringify({ mcpServers: { vsdiff: { command: 'vsdiff', args: ['mcp'] } } }, null, 2)}\n`,
    );
    actions.push(`wrote ${mcpPath}`);
  } else {
    actions.push(`kept existing ${mcpPath} (add a "vsdiff" server entry manually if missing)`);
  }

  if (options.skill === 'claude') {
    const source = packagedSkillPath();
    if (!existsSync(source)) {
      throw new Error(`packaged skill not found at ${source} — is this a complete vsdiff install?`);
    }
    const target = join(repoRoot, '.claude', 'skills', 'vsdiff', 'SKILL.md');
    const existed = existsSync(target);
    await mkdir(dirname(target), { recursive: true });
    // Unlike .mcp.json (user-owned, never clobbered), the skill is tool-owned:
    // reruns keep it current with the installed vsdiff.
    await writeFile(target, await readFile(source, 'utf8'));
    actions.push(`${existed ? 'updated' : 'installed'} skill → ${target}`);
  } else if (options.skill !== undefined) {
    throw new Error(`unknown --skill "${options.skill}" (supported: claude)`);
  }

  return { actions };
}

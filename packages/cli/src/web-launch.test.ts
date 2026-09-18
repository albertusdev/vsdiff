import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureConnectionToken, folderUrl, locateVsix, webSettings } from './web-launch.ts';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('webSettings', () => {
  const env = { HOME: '/home/u' };

  it('defaults port and dataDir under the cache dir', () => {
    const settings = webSettings({}, env);
    expect(settings.port).toBe(3123);
    expect(settings.dataDir).toBe('/home/u/.cache/vsdiff/serve-web');
    expect(settings.stateDir).toBe('/home/u/.cache/vsdiff');
  });

  it('honors XDG_CACHE_HOME and config overrides', () => {
    const settings = webSettings(
      { web: { port: 4111, dataDir: '~/x/web' } },
      { ...env, XDG_CACHE_HOME: '/xdg' },
    );
    expect(settings.port).toBe(4111);
    expect(settings.dataDir).toBe('/home/u/x/web');
    expect(settings.stateDir).toBe('/xdg/vsdiff');
  });

  it('rejects nonsense ports back to the default', () => {
    expect(webSettings({ web: { port: 0 } }, env).port).toBe(3123);
    expect(webSettings({ web: { port: 3.5 } }, env).port).toBe(3123);
    expect(webSettings({ web: { port: 99999 } }, env).port).toBe(3123);
  });
});

describe('folderUrl', () => {
  it('is the harness-proven serve-web form', () => {
    expect(folderUrl(3123, '/home/u/dev/repo')).toBe(
      'http://localhost:3123/?folder=%2Fhome%2Fu%2Fdev%2Frepo',
    );
  });
});

describe('locateVsix', () => {
  it('walks up to the nearest dist/vsdiff.vsix and gives up cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'vsdiff-web-'));
    cleanups.push(root);
    const deep = join(root, 'packages', 'cli', 'dist');
    mkdirSync(deep, { recursive: true });
    expect(locateVsix(deep)).toBeNull();
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'vsdiff.vsix'), 'x');
    expect(locateVsix(deep)).toBe(join(root, 'dist', 'vsdiff.vsix'));
  });
});

describe('web credentials', () => {
  it('persists a private random token and keeps folder query characters literal', () => {
    const root = mkdtempSync(join(tmpdir(), 'vsdiff-token-'));
    cleanups.push(root);
    const token = ensureConnectionToken(root);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureConnectionToken(root)).toBe(token);
    expect(statSync(join(root, 'connection-token')).mode & 0o777).toBe(0o600);
    const url = new URL(folderUrl(3123, '/repo with &tkn=bad#fragment', token));
    expect(url.searchParams.get('folder')).toBe('/repo with &tkn=bad#fragment');
    expect(url.searchParams.get('tkn')).toBe(token);
  });
  it('refuses a symlink in place of the credential file', () => {
    const root = mkdtempSync(join(tmpdir(), 'vsdiff-token-link-'));
    cleanups.push(root);
    writeFileSync(join(root, 'outside'), 'x');
    symlinkSync(join(root, 'outside'), join(root, 'connection-token'));
    expect(() => ensureConnectionToken(root)).toThrow('regular file');
  });
});

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export function isRelativeFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes('\\') &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').includes('..')
  );
}

/** Both lexical traversal and symlink escapes are rejected at the point of use. */
export async function containedFile(base: string, path: string): Promise<string | undefined> {
  if (!isRelativeFilePath(path)) return undefined;
  try {
    const root = await realpath(base);
    const target = await realpath(resolve(root, path));
    const child = relative(root, target);
    if (
      child === '' ||
      child === '..' ||
      child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(child)
    )
      return undefined;
    return target;
  } catch {
    return undefined;
  }
}

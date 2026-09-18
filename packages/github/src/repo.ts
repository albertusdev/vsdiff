// `owner/repo` for the REST paths. gh resolves it from the checkout's remotes,
// which is also the cheapest "is this a GitHub repo at all" probe we have.

import { ghError, outputError } from './errors.ts';
import { parseJsonObject } from './json.ts';
import type { RunGh } from './types.ts';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function nameWithOwner(runGh: RunGh): Promise<string> {
  const args = ['repo', 'view', '--json', 'nameWithOwner'];
  const run = await runGh(args);
  if (run.code !== 0) throw ghError(args, run, 'this repository');
  const raw = parseJsonObject(args, 'repository JSON', run.stdout);
  const slug = raw.nameWithOwner;
  // The slug goes into an API path in argv; anything else is not a repo name.
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw outputError(args, 'repository name', JSON.stringify(raw));
  }
  return slug;
}

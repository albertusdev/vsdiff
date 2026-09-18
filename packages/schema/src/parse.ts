// The permissive read path (D2): the loader accepts anything with the structural
// minimum, keeps unknown fields, and leaves optionals to be defaulted downstream.
// Everything sharper — enums, id uniqueness, hunk-id shape — is `vsdiff validate`
// (see ./validate.ts), so a session never fails to open over a nit.

import { SCHEMA_VERSION, type ReviewSession } from './types.ts';

export type ParseResult = { ok: true; session: ReviewSession } | { ok: false; errors: string[] };

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSession(json: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
  }
  if (!isRecord(data)) {
    return { ok: false, errors: ['session must be a JSON object'] };
  }

  const errors: string[] = [];
  if (data['version'] !== SCHEMA_VERSION) {
    errors.push(`"version" must be ${SCHEMA_VERSION}`);
  }
  if (data['kind'] !== 'review') {
    errors.push('"kind" must be "review"');
  }
  if (typeof data['title'] !== 'string' || data['title'].length === 0) {
    errors.push('"title" must be a non-empty string');
  }
  if (!isRecord(data['source']) || typeof data['source']['type'] !== 'string') {
    errors.push('"source" must be an object with a "type"');
  }
  if (!Array.isArray(data['chapters'])) {
    errors.push('"chapters" must be an array');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, session: data as unknown as ReviewSession };
}

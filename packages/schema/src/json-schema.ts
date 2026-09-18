// The published JSON Schema (draft 2020-12), served by `vsdiff guide --schema`.
// It is hand-authored in ./review-session.schema.json so it can be published as a
// file; tsdown inlines the JSON at build time, so the built package carries no
// runtime file read.

import schema from './review-session.schema.json' with { type: 'json' };

/** A deep copy — callers print, serve, or feed this to a validator; none of them
 *  should be able to mutate the module's copy. */
export function getJsonSchema(): object {
  return structuredClone(schema) as object;
}

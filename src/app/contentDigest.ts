/**
 * Content digests shared by every harness module that must identify exact
 * bytes: sha256 hex over UTF-8 (the same `node:crypto` primitive
 * `src/ui/reviewFlow.ts` uses for its prompt hash) and a canonical
 * sorted-key JSON serialization so structurally identical objects always
 * digest identically regardless of construction order. Hoisted out of
 * `reviewRunSnapshotBuilder.ts` (task 6.1) so the evidence ledger (task 7.1)
 * reuses one algorithm rather than a second hashing convention.
 */
import { createHash } from 'node:crypto';

export const CONTENT_DIGEST_ALGORITHM = 'sha256';

export function sha256Hex(text: string): string {
  return createHash(CONTENT_DIGEST_ALGORITHM).update(text, 'utf8').digest('hex');
}

/**
 * A value JSON has no token for. `undefined` and `null` both mean "nothing
 * recorded" in most of this codebase, but they are not the same input, and a
 * digest that cannot tell them apart is a digest that can call two different
 * snapshots identical. Object *properties* already distinguish them — an
 * `undefined` key is dropped below, a `null` key is kept — so this only
 * covers the two places that reach a bare `undefined`: a top-level value
 * (`harnessResume.ts` compares optional fields this way) and an array
 * element.
 *
 * The token is deliberately not valid JSON, so no serializable value can ever
 * produce it and collide. It is also plain ASCII: this output becomes the
 * `exactContent` of search and detail evidence, and a control character would
 * end up in persisted content.
 */
const UNDEFINED_TOKEN = 'undefined';

/** Sorted-key JSON; array order is preserved because it is part of what a reader saw. */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return UNDEFINED_TOKEN;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(',')}}`;
}

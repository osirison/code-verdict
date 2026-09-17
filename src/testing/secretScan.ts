/**
 * The one decoder every "did a secret reach this sink?" scan in the test suite
 * searches through.
 *
 * A marker scan that searches only the raw bytes of a planted secret reads like
 * a thorough proof and is not one: by the time text reaches a sink the secret
 * has usually been encoded at least once — JSON-escaped by whatever serialized
 * the record, base64'd by the `Basic <base64>` credential both git transports
 * compose, percent-encoded by a URL builder — and every one of those forms is
 * still a credential to anyone who reads the file. The marker really is absent
 * from the text, and really is present in the file. So a scan searches the
 * haystack AND the same bytes with each of those encodings already undone.
 *
 * Extracted from `harnessPersistenceInspection.assurance.test.ts`, which wrote
 * the first version of this and is now one of its callers: a second decoder
 * written beside the first is exactly the duplication this codebase's reuse
 * rule exists to stop, and the second one is always the one that forgets an
 * encoding.
 *
 * The decoding is deliberately crude. It is looking for a known marker, not
 * parsing anything, so a mangled decode of an unrelated run costs nothing but a
 * few bytes of extra haystack. Every caller is expected to keep it honest with
 * a self-check — assert that `withDecodedForms` of a deliberately encoded
 * marker DOES contain the marker — because a decoder that silently returned its
 * input would make every assertion built on it vacuous.
 */

/**
 * A run long enough to be a credential rather than a word that happens to fit
 * the alphabet. The class is the union of standard base64 and base64url
 * (`-`/`_` for `+`/`/`), so one sweep covers both; `normalizeBase64` below puts
 * a base64url run back into the standard alphabet before decoding.
 */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

function normalizeBase64(run: string): string {
  return run.replace(/-/g, '+').replace(/_/g, '/');
}

/** Percent-escapes only, decoded run by run: `decodeURIComponent` over a whole haystack throws on the first stray `%`, which would silently disable this form for the entire scan. */
function decodePercentRuns(haystack: string): string {
  return haystack.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * `haystack` plus the same bytes with each encoding a secret can reach a sink
 * in already undone: JSON/unicode escaping, base64 and base64url, and
 * percent-encoding. Search the result, not the original.
 */
export function withDecodedForms(haystack: string): string {
  const unescaped = haystack
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
  const decodedRuns = (haystack.match(ENCODED_RUN) ?? [])
    .map((run) => Buffer.from(normalizeBase64(run), 'base64').toString('utf8'))
    .join('\n');
  return [haystack, unescaped, decodedRuns, decodePercentRuns(haystack)].join('\n');
}

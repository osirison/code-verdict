/**
 * Recursive allowlist sanitizer and redactor for everything that reaches the
 * sanitized activity protocol (task 5.5 of `add-agentic-review-harness`,
 * design.md D5/D13/D14, spec `review-run-activity`).
 *
 * The `ActivityEvent` union (`../domain/harnessActivity`, task 2.3) has no
 * field shaped to carry a raw prompt, a full model response, hidden
 * reasoning, or a full tool argument/output payload in the first place —
 * that is a structural guarantee, not something this module enforces by
 * pattern-matching content. What this module defends is the CONTENT of the
 * few public string/metadata fields the union does allow (a rationale, a
 * tool target, a completion/failure summary, an error reason): a legitimate
 * field can still be made to carry a leaked secret or a fragment of raw
 * output, so every such field is redacted and bounded here before
 * `appendActivityEvent` (`./harnessActivityLog`) will accept it.
 *
 * This is a best-effort content boundary, not a complete DLP system: secret
 * pattern matching cannot catch every possible credential shape, and a
 * determined source could still exfiltrate bounded fragments across many
 * events. Volumetric limits (`maxActivityEventsPerAttempt`,
 * `maxActivityBytesPerAttempt`, `../domain/harnessPolicy`) are the
 * complementary control for that, enforced by a later task's dispatcher.
 */

/** "Concise" per the spec — well past this length, a field is almost certainly not legitimate rationale/summary text. */
export const MAX_PUBLIC_TEXT_LENGTH = 240;

/** Bounds redaction work itself so an oversized input cannot cost more than a fixed amount of CPU before being truncated anyway. */
export const MAX_RAW_TEXT_SCAN_LENGTH = 10_000;

export const MAX_METADATA_DEPTH = 4;
export const MAX_METADATA_ENTRIES = 20;
export const MAX_METADATA_ARRAY_ITEMS = 10;

// Standalone credential shapes: the whole match is the secret, so it is replaced outright.
const STANDALONE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / user-to-server / server-to-server tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab personal access token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

// `name=value` / `name: value` shapes: keep the name, redact only the value, so the public text
// can still say a credential was involved without exposing it. Bounded quantifiers only — no
// nested/overlapping repetition, so this cannot be driven into catastrophic backtracking.
const KEYED_SECRET_PATTERN =
  /\b(token|secret|password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret|authorization)(\s*[:=]\s*)"?[^\s"&,}]{4,}"?/gi;

function redactSecrets(text: string): string {
  const withKeyedRedacted = text.replace(
    KEYED_SECRET_PATTERN,
    (_match, name: string, sep: string) => `${name}${sep}[REDACTED]`,
  );
  return STANDALONE_SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), withKeyedRedacted);
}

// Control characters have no business in a one-line public label; stripping them defends against
// escape-sequence/log injection into an output channel or webview.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Fails closed: anything that is not a non-empty string after cleaning
 * returns `undefined`, so a caller (the builder) can refuse to append the
 * event rather than store something guessed.
 */
export function sanitizePublicText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const bounded = raw.length > MAX_RAW_TEXT_SCAN_LENGTH ? raw.slice(0, MAX_RAW_TEXT_SCAN_LENGTH) : raw;
  const redacted = redactSecrets(bounded).replace(CONTROL_CHARS, '');
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_PUBLIC_TEXT_LENGTH ? `${collapsed.slice(0, MAX_PUBLIC_TEXT_LENGTH - 1)}…` : collapsed;
}

export type SanitizedMetadataValue = string | number | boolean;
export type SanitizedMetadata = Readonly<Record<string, SanitizedMetadataValue>>;

// Dropped entirely, never redacted-in-place: a value under one of these keys is assumed wholly
// secret or wholly raw model/tool content, not text that merely mentions one.
const METADATA_KEY_DENYLIST = new Set([
  'prompt',
  'rawprompt',
  'response',
  'rawresponse',
  'rawtext',
  'messages',
  'reasoning',
  'chainofthought',
  'thinking',
  'arguments',
  'args',
  'output',
  'fulloutput',
  'stdout',
  'stderr',
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'clientsecret',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectMetadata(
  value: unknown,
  prefix: string,
  out: Record<string, SanitizedMetadataValue>,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (Object.keys(out).length >= MAX_METADATA_ENTRIES) return;
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const cleaned = sanitizePublicText(value);
    if (cleaned !== undefined && prefix !== '') out[prefix] = cleaned;
    return;
  }
  if (typeof value === 'number') {
    if (prefix !== '' && Number.isFinite(value)) out[prefix] = value;
    return;
  }
  if (typeof value === 'boolean') {
    if (prefix !== '') out[prefix] = value;
    return;
  }
  if (typeof value !== 'object') return; // function, symbol, bigint: not a public fact, dropped
  if (depth >= MAX_METADATA_DEPTH) return;
  if (seen.has(value)) return; // circular reference guard
  seen.add(value);
  if (Array.isArray(value)) {
    value.slice(0, MAX_METADATA_ARRAY_ITEMS).forEach((item, index) => {
      collectMetadata(item, prefix ? `${prefix}.${index}` : `${index}`, out, seen, depth + 1);
    });
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METADATA_ENTRIES) return;
    if (METADATA_KEY_DENYLIST.has(normalizedKey(key))) continue;
    collectMetadata(nested, prefix ? `${prefix}.${key}` : key, out, seen, depth + 1);
  }
}

/**
 * Recursively allowlists an arbitrary untrusted value down to a flat,
 * bounded record of primitive public facts: known-dangerous keys are
 * dropped at any depth, every surviving string is redacted and length
 * capped, depth/entry-count/array-length are all bounded, and a circular
 * reference cannot cause unbounded recursion.
 */
export function sanitizeMetadata(raw: unknown): SanitizedMetadata {
  const out: Record<string, SanitizedMetadataValue> = {};
  collectMetadata(raw, '', out, new WeakSet<object>(), 0);
  return out;
}

/**
 * Reduces a rich, untrusted error/failure value to one short sanitized
 * public reason — for `toolFailed.reason` / `waiting.reason` /
 * `paused.reason`. An unrecognized shape falls back to a fixed generic
 * message instead of guessing at a stringification of untrusted data.
 */
export function sanitizeErrorReason(raw: unknown, fallback = 'an unexpected error occurred'): string {
  if (typeof raw === 'string') return sanitizePublicText(raw) ?? fallback;
  if (raw instanceof Error) return sanitizePublicText(raw.message) ?? fallback;
  if (raw && typeof raw === 'object') {
    const metadata = sanitizeMetadata(raw);
    const message = metadata.message ?? metadata.reason ?? metadata.code;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

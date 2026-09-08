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
 * ## Why redaction is no longer primarily a pattern match
 *
 * This module lost three times in one day, each time to a credential that was
 * plainly present and simply did not have the surrounding syntax the pattern
 * expected:
 *
 * 1. `Authorization: Bearer <token>` — the keyed pattern's value class stops
 *    at the first space, so it captured the word "Bearer" as the secret and
 *    printed the token immediately after the `[REDACTED]` it had just
 *    written. Fixed by teaching the pattern one scheme word.
 * 2. `Authorization: Basic <base64>` — the identical hole, reopened the same
 *    day by a different scheme word, when the object-source descriptor
 *    stopped composing bearer tokens for `git fetch`. Fixed by teaching the
 *    pattern a second scheme word.
 * 3. `{"token":"<secret>"}` — a quoted JSON key. The keyed pattern wants the
 *    key name followed by `:` or `=`; a JSON key has a closing quote in
 *    between, so it never matched at all. Measured against the real function,
 *    not read off it:
 *
 *        LEAKS     {"token":"SECRETabcdefgh1234567890"}
 *        LEAKS     {"token" : "SECRETabcdefgh1234567890"}
 *        LEAKS     {"apiKey":"SECRETabcdefgh1234567890"}
 *        redacted  token=SECRETabcdefgh1234567890
 *        redacted  Authorization: Bearer SECRETabcdefgh1234567890
 *
 *    With `codeVerdict.trace.api` on, `apiTrace.ts` routes whole request and
 *    response BODIES through this module, and a JSON body is precisely the
 *    shape a credential arrives in. The credential reached the trace in plain
 *    text.
 *
 * A fourth alternative in the same pattern would have bought a fourth
 * postponement. A defence that recognises a secret by the syntax AROUND it
 * keeps losing, because every new caller brings syntax the last fix never
 * saw. So the pattern was demoted, and two defences that do not depend on
 * surrounding syntax were put in front of it. `redactSecrets` now runs three
 * layers, in this order:
 *
 * - **Known values** (`registerSecretValue`). The host holds the credential
 *   for every connection it opens (`./connections.ts` builds it), so the
 *   strongest statement available is not "this looks like a secret" but
 *   "this IS the secret, wherever it appears". A registered value is removed
 *   from a JSON field, a header, a URL or a prose sentence alike, and — via
 *   the structural walk below, which decodes before it looks — from a value
 *   whose escaping means the raw bytes are nowhere in the text. This is the
 *   only layer whose correctness does not depend on having enumerated the
 *   call sites.
 * - **Structure** (`redactJsonShapedText`). For JSON-shaped text, the value
 *   under a secret-named key is found by walking the string literals rather
 *   than by matching a shape: escaped quotes, escaped backslashes, `\uXXXX`
 *   in the key name, arbitrary whitespace, nesting, arrays, key casing and
 *   JSON embedded inside a JSON string are all handled because the walk
 *   decodes each literal instead of guessing at it. It rewrites only the
 *   spans it redacts, so a traced body is otherwise byte-identical to what
 *   crossed the wire — deliberately not `JSON.parse` + `JSON.stringify`,
 *   which would silently reformat numbers and reorder integer-like keys in a
 *   channel whose whole promise is showing exactly what was sent.
 * - **Patterns**, last, for text that was never structured at all: a
 *   `name=value` fragment in a log line, a bare `ghp_…`, an `Authorization:`
 *   header rendered as prose. A backstop is a defensible job for them; being
 *   the only thing between a credential and the disk is not.
 *
 * ## The adversarial pass after that, and what it changed
 *
 * An adversarial review of the three layers above got a credential past them
 * six ways, five of them demonstrated against these exported functions. Each
 * fix carries its own measurement at the code that changed rather than being
 * summarised here, but the shape of all six is worth naming once, because it
 * is the same shape three times over: a rule that was RIGHT about what makes
 * a secret, and wrong about how far the rule reached.
 *
 * - A secret-named key bound only to a scalar, so a container under it was
 *   judged by its members' own names (`walkJsonLiterals`).
 * - The literal walk paired quotes by parity, so one stray quote disabled it
 *   for everything after — in error messages quoting a malformed body, which
 *   is where credentials turn up (`redactJsonShapedText`).
 * - `sanitizePublicText` bounded before it redacted, printing the surviving
 *   half of a credential it cut (`sanitizePublicText`).
 * - `METADATA_KEY_DENYLIST` was still the exact-name enumeration this header
 *   says stopped working, running one level down (`RAW_CONTENT_KEY_SUFFIXES`).
 * - The keyed pattern could not see past a 24-character key name
 *   (`KEYED_SECRET_PATTERN`).
 * - `apiTrace.ts` routed only its BODY lines here; the URL, the failure line
 *   and the GraphQL operation name went through one query-parameter regex
 *   (`apiTrace.ts`'s own `redactTracedText`).
 *
 * A seventh, found while testing the second: a credential the host holds, cut
 * in half by a truncated body under a key name that says nothing, stopped
 * being an exact needle and printed (`redactTruncatedRegisteredValue`).
 *
 * ## What this still cannot catch, stated plainly
 *
 * - A secret the host never held, with no key name and no scheme word beside
 *   it — a bare high-entropy string in prose — passes every layer. No
 *   value-based layer knows it, no key names it, and no pattern can redact
 *   every long word without destroying ordinary text.
 * - A secret under a key name shaped like nothing in `isSecretKeyName`, in a
 *   syntax that is not JSON: `<token>value</token>`, YAML block scalars,
 *   form-encoded bodies. The known-value layer covers these when the host
 *   holds the value; nothing else does. The structural walk's "a secret-named
 *   key covers everything beneath it" rule is JSON-shaped too, so
 *   `<token><v>SECRET</v></token>` and a YAML `token:` block both still print
 *   — measured, not assumed.
 * - The last few characters of a credential a truncated body cut short.
 *   Both layers that can see a fragment have a floor: the keyed pattern wants
 *   four characters of value before it calls something a secret, and the
 *   known-value layer's truncated-tail rule (`redactTruncatedRegisteredValue`)
 *   wants eight. Below those, `token=SEC` and the first seven bytes of a held
 *   credential print. Both floors exist because shorter runs are ordinary text
 *   far more often than they are credentials, and both are asserted in
 *   `harnessActivitySanitizer.test.ts` rather than left as an accident.
 * - A registered secret re-encoded by something this module cannot derive.
 *   `registerSecretValue` stores the value plus its base64, base64url,
 *   percent-encoded and JSON-escaped forms, but base64 of
 *   `"<username>:<token>"` — what `basicAuthorizationHeaderValue`
 *   (`../platform/provider.ts`) composes — is a different string, and whether
 *   the token's own base64 survives inside it is pure alignment: it does when
 *   the bytes before the token divide by three (`x-access-token:` is 15, so
 *   it does) and not otherwise (`oauth2:` is 7, so it does not). The shape is
 *   covered either way by the `Basic` standalone pattern, which redacts the
 *   whole encoded run — but only while the literal `Basic ` prefix is still
 *   attached to it. Both halves are asserted in
 *   `harnessActivitySanitizer.test.ts` rather than described here and assumed.
 * - `AgentTrace.debugRawPrompt` / `debugRawResponse` / `debugRawPart`
 *   (`./agentTrace.ts`) are deliberately unredacted and deliberately not
 *   routed here — a documented decision about a live-only channel behind
 *   `codeVerdict.trace.rawPayloads`, not an oversight this module should
 *   quietly start covering. That exemption is only as sound as the
 *   "live-only" half of it, which was FALSE until 2026-09-11: those methods
 *   wrote to a sink `installAgentTraceFile` tees into `agent-trace.log`, so
 *   unredacted prompts and replies were going to disk by the megabyte. They
 *   now write to a separate live sink `AgentTrace` is handed explicitly.
 *   Routing them through this module instead was considered and rejected:
 *   redaction is not what keeps a raw prompt off disk — a diff and a model's
 *   full reply are prohibited from a durable sink because of what they are,
 *   and no amount of credential redaction changes that.
 *
 * This remains a best-effort content boundary, not a complete DLP system, and
 * a determined source could still exfiltrate bounded fragments across many
 * events. Volumetric limits (`maxActivityEventsPerAttempt`,
 * `maxActivityBytesPerAttempt`, `../domain/harnessPolicy`) are the
 * complementary control for that, enforced by a later task's dispatcher.
 */

/** "Concise" per the spec — well past this length, a field is almost certainly not legitimate rationale/summary text. */
export const MAX_PUBLIC_TEXT_LENGTH = 240;

export const MAX_METADATA_DEPTH = 4;
export const MAX_METADATA_ENTRIES = 20;
export const MAX_METADATA_ARRAY_ITEMS = 10;

/** The one replacement string every layer writes, so a reader never has to wonder whether two spellings mean two things. */
const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Layer 1: the values the host actually holds
// ---------------------------------------------------------------------------

/**
 * Short enough to be a word. Globally replacing every occurrence of a
 * four-character string would shred ordinary text — a six-character token is
 * still a token, but redacting it everywhere costs more than it saves, and
 * the structural and pattern layers still cover it wherever it appears under
 * a key name or a scheme word. Eight is the shortest length at which a
 * credential-shaped string is unlikely to also be a word in a sentence.
 */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Every form of every known secret, flattened: the raw value and each
 * encoding it can travel in are separate needles, because by the time text
 * reaches this module the encoding has already happened and there is nothing
 * left to decode structurally.
 */
const registeredSecretForms = new Set<string>();

/** `registeredSecretForms` in descending length order, so a longer form is always redacted before a shorter one contained in it. Rebuilt on registration, never on the hot path. */
let secretFormsLongestFirst: readonly string[] = [];

/**
 * Every encoding of a secret derivable from the secret alone. Derived once at
 * registration rather than attempted at redaction time: a redaction pass runs
 * over every traced body and every public field, and it must not be doing
 * base64 work per call.
 *
 * Deliberately NOT here: base64 of `"<username>:<secret>"`. That is what
 * `basicAuthorizationHeaderValue` composes, but it cannot be derived from the
 * secret — the username is a rule of the platform being talked to and this
 * module is provider-agnostic. The base64 below happens to catch it anyway
 * when the prefix length divides by three, which is luck rather than cover;
 * the alignment tricks that would make that reliable find a substring of the
 * encoding and leave the bytes around it in place, which is a partial
 * credential, not a redaction. The `Basic` standalone pattern covers that
 * shape whole. See this module's own limits paragraph.
 */
function encodedFormsOf(value: string): readonly string[] {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return [
    value,
    base64,
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), // base64url, as a credential in a URL arrives
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1), // the value as it appears once embedded in a JSON string literal
  ];
}

/**
 * Tells the redactor about a credential the host is holding, so that every
 * layer below can be wrong about shapes and the value still never reaches a
 * sink. Called from `./connections.ts` at the single point where a credential
 * is materialised for a pod, for both credential kinds.
 *
 * Accepts `unknown` and fails closed on anything that is not a long enough
 * string: a caller must never have to guard before calling, because a caller
 * that has to remember something is a caller that will eventually forget.
 * Registration is cumulative and deduplicated — reconnecting the same pod
 * re-registers the same value and adds nothing. Nothing reads the set back
 * out; a redaction is the only observable effect it has.
 */
export function registerSecretValue(value: unknown): void {
  if (typeof value !== 'string' || value.length < MIN_REGISTERED_SECRET_LENGTH) return;
  let added = false;
  for (const form of encodedFormsOf(value)) {
    if (form.length < MIN_REGISTERED_SECRET_LENGTH || registeredSecretForms.has(form)) continue;
    registeredSecretForms.add(form);
    added = true;
  }
  if (added) secretFormsLongestFirst = [...registeredSecretForms].sort((a, b) => b.length - a.length);
}

/**
 * Drops every registered value. Nothing in production calls this: a credential stays registered for
 * as long as the extension host lives, which is the safe direction — forgetting one only creates a
 * window in which it prints. It exists for tests, which share this module state within a file and
 * would otherwise redact each other's fixtures.
 */
export function clearRegisteredSecretValues(): void {
  registeredSecretForms.clear();
  secretFormsLongestFirst = [];
}

function redactRegisteredValues(text: string): string {
  if (secretFormsLongestFirst.length === 0) return text;
  let out = text;
  for (const form of secretFormsLongestFirst) {
    if (out.includes(form)) out = out.split(form).join(REDACTED);
  }
  return redactTruncatedRegisteredValue(out);
}

/**
 * The needle match above is exact, so a credential the transport cut in half is not a needle any
 * more and passes straight through. Found by sweeping every truncation offset through a held value
 * under an ordinary key name — the structural walk's own redact-to-end rule does not apply there,
 * because nothing about `"note"` says the value beneath it is a credential:
 *
 *     {"a":1,"note":"SECRETabc          ->  printed "SECRETabc" (23 of 24 offsets leaked a prefix)
 *
 * A text that ENDS with the beginning of a value the host holds is a text that was cut mid-value:
 * there is no other way for those bytes to be the last thing in the string. So the tail is
 * replaced. Only the tail — a prefix appearing anywhere else in the text is ordinary content that
 * happens to share a few leading characters, and redacting those would shred prose.
 *
 * `MIN_REGISTERED_SECRET_LENGTH` is the floor here for the same reason it is the floor for
 * registration: below eight characters a run is a word before it is a credential fragment. The
 * whole scan costs a handful of `endsWith` calls against strings the length of a token, never
 * anything proportional to the text being scanned.
 */
function redactTruncatedRegisteredValue(text: string): string {
  if (text.length === 0) return text;
  for (const form of secretFormsLongestFirst) {
    const longest = Math.min(form.length - 1, text.length);
    for (let length = longest; length >= MIN_REGISTERED_SECRET_LENGTH; length -= 1) {
      if (text.endsWith(form.slice(0, length))) return `${text.slice(0, text.length - length)}${REDACTED}`;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Layer 3, declared first because layer 2 borrows its key vocabulary: patterns
// ---------------------------------------------------------------------------

// Standalone credential shapes: the whole match is the secret, so it is replaced outright.
const STANDALONE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // `Basic <base64>` is the git-over-HTTPS credential both providers compose
  // (task 2.4, corrected 2026-09-09 — neither forge's git transport accepts a
  // bearer token). Base64 is an encoding, not protection: one call decodes it
  // back to `<username>:<token>`. Sixteen characters keeps it off ordinary
  // prose, where a word that long in one unbroken run after "Basic" does not
  // occur.
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / user-to-server / server-to-server tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab personal access token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

// `name=value` / `name: value` shapes: keep the name, redact only the value, so the public text
// can still say a credential was involved without exposing it. Bounded quantifiers only — no
// nested/overlapping repetition, so this cannot be driven into catastrophic backtracking.
//
// The optional `(?:(?:Bearer|Basic)\s+)?` before the value is load-bearing, not decorative: an
// `Authorization: Bearer <token>` header rendered as text is a keyed match on `authorization`
// whose "value" — greedily read as `[^\s"&,}]{4,}` — would otherwise stop at the first space and
// capture only the literal word "Bearer", leaving the real token sitting in plain text right after
// the `[REDACTED]` this pattern just wrote. Swallowing an optional scheme word as part of the
// value folds scheme and secret into one match, so the whole thing is replaced together. Verified
// against `PRIVATE-TOKEN: <token>` too (`\b` before `token` matches across the `-`, so the same
// keyed path already covered GitLab's header name without this change).
//
// `Basic` joined `Bearer` on 2026-09-09, when the object-source descriptor stopped composing a
// bearer token for `git fetch` — neither forge's git transport accepts one — and started composing
// `Basic base64("<username>:<token>")`. That is the identical hole re-opened by a different scheme
// word: without `Basic` here, `Authorization: Basic <base64>` redacts the word "Basic" and prints
// the encoded credential in full. `harnessActivitySanitizer.test.ts` holds both schemes.
//
// The `[A-Za-z0-9_.-]{0,24}` prefix on the name group closes a fourth hole, found while fixing the
// third and measured the same way. `\b` cannot match between `_` and `t`, so a bare `token`
// alternative never matched a key whose name merely ENDS in one. Against the real function before
// this change:
//
//     LEAKS     refresh_token=SECRETabcdefgh1234567890
//     LEAKS     refreshToken=SECRETabcdefgh1234567890
//     LEAKS     GITHUB_TOKEN=SECRETabcdefgh1234567890
//     LEAKS     session_secret: SECRETabcdefgh1234567890
//     redacted  x-api-key: SECRETabcdefgh1234567890
//
// The prefix is one character class bounded at 24, so the extra work is a constant per start
// position rather than nested repetition; `harnessActivitySanitizer.test.ts` times it against an
// unbroken 120 KB identifier run, the input that would expose backtracking if there were any.
//
// The `\b` that used to sit in front of that prefix turned the 24 into a hard limit on the WHOLE
// key name, which an adversarial pass then walked straight past — measured:
//
//     LEAKS     aaaaaaaaaaaaaaaaaaaaaaaaa_token=SECRETabcdefgh1234567890   (25-char prefix)
//
// `_` is a word character, so there is no word boundary anywhere inside a long identifier: the
// engine could not start the match late enough to fit the name into the window, and could not
// start it early enough to satisfy `\b`. Dropping `\b` lets the window SLIDE to wherever the
// secret word actually ends, and costs nothing in output fidelity — the captured name is rebuilt
// verbatim by the replacement, and the part of the name the window never reached was never
// consumed, so it is copied through untouched. A 200-character key still prints in full with only
// its value replaced. Raising the bound instead would have bought the same postponement a fourth
// pattern alternative would: the next key name is always longer than the last fix.
//
// `private[-_]?key` and `credentials?` are here to match `SECRET_KEY_SUFFIXES` below, which the
// structural layer already used: a `?private_key=` query parameter is not JSON, so the structural
// layer never sees it, and before this the two layers disagreed about what counts as a credential
// name depending only on whether the text happened to be JSON.
const KEYED_SECRET_PATTERN =
  /([A-Za-z0-9_.-]{0,24}(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|credentials?|authorization))(\s*[:=]\s*)"?(?:(?:Bearer|Basic)\s+)?[^\s"&,}]{4,}"?/gi;

// ---------------------------------------------------------------------------
// Layer 2: structure
// ---------------------------------------------------------------------------

/**
 * Matched as a SUFFIX of the normalized key name, never as exact set
 * membership. An exact set would be the same mistake as an exact pattern one
 * level up: `refresh_token`, `PRIVATE-TOKEN`, `githubToken` and `x-api-key`
 * are all the key this is trying to catch, and enumerating them is the
 * enumeration that keeps failing. `normalizedKey` strips case and punctuation
 * first, so only the word itself matters.
 */
const SECRET_KEY_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'credential',
  'credentials',
  'privatekey',
];

/** Secret-carrying names that are nobody's suffix, so a suffix test alone would need them spelled out. */
const SECRET_KEY_EXACT = new Set(['authorization', 'cookie', 'setcookie', 'auth']);

function isSecretKeyName(name: string): boolean {
  const normalized = normalizedKey(name);
  if (normalized.length === 0) return false;
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** How far a JSON-inside-a-JSON-string nesting is followed before the walk gives up. Three is past anything a real body does, and keeps the total work linear in the input. */
const MAX_NESTED_TEXT_DEPTH = 3;

/** JSON's three bare words are values but never secrets; redacting them would only make a trace harder to read. */
const BARE_JSON_LITERALS = new Set(['null', 'true', 'false']);

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Index of the closing quote of the string literal starting at `start`, or `-1` if the text ends
 * first. Escapes are handled by parity, stepping two characters past a backslash: the classic
 * scanner bug is to treat the `"` in `"ends with \\"` as escaped when the backslash before it was
 * itself escaped, which ends the literal in the wrong place and drags the rest of the document
 * into it.
 */
function endOfStringLiteral(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}

/** A literal is a key exactly when a colon follows it, whitespace aside. Nothing else about the document has to be parsed to know that. */
function followedByColon(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    if (isJsonWhitespace(text[i]!)) continue;
    return text[i] === ':';
  }
  return false;
}

/** `JSON.parse` of the literal's own span: `\uXXXX`, `\"` and `\\` come back decoded for free, so a key spelled `"token"` is recognised as `token`. */
function decodeStringLiteral(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Index just past the container that opens at `start`, or the end of the text when the container is
 * never closed — which a truncated body is, every time.
 *
 * String literals are skipped whole rather than scanned for brackets, because a `}` inside a string
 * value closes nothing and counting it would end the container early, leaving the real tail of it
 * in plain text. Depth counting handles the nesting; there is nothing else to track.
 */
function endOfContainer(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = endOfStringLiteral(text, i);
      // An unterminated literal inside the container means the text stops mid-value; the container
      // runs to the end of what there is.
      if (end === -1) return text.length;
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth <= 0) return i + 1;
    }
  }
  return text.length;
}

/** End of an unquoted value — a number, or a bare word in a near-JSON fragment: the first delimiter after it. */
function endOfBareValue(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (isJsonWhitespace(ch) || ch === ',' || ch === '}' || ch === ']' || ch === '{' || ch === '[' || ch === '"') return i;
  }
  return text.length;
}

/**
 * Whether a string value is worth decoding and re-scanning one level down. Two reasons, and the
 * second was missing until it was measured:
 *
 * 1. The decoded text may itself be structured — a JSON body carried inside a JSON string, a
 *    `name=value` fragment — which the outer walk sees only as one opaque literal.
 * 2. The literal contains a backslash AT ALL. Escaping means the bytes in the outer text are not
 *    the bytes of the value, so every needle the known-value layer holds can miss a secret that is
 *    plainly there. With `zX9-held-credential-value-42` registered, the same value written with
 *    its first letter spelled as a unicode escape — `{"note":"\u007aX9-held-credential-value-42"}`
 *    — used to survive all three layers: the raw form never appears in the text, the canonical
 *    JSON escaping of it is the raw form again, and the key is not secret-named, so nothing
 *    looked. Decoding first is the only thing that sees it, which is this module's own argument
 *    against matching shapes, applied one level in.
 */
function worthRescanning(literal: string, decoded: string): boolean {
  return literal.includes('\\') || decoded.includes('"') || decoded.includes(':') || decoded.includes('=');
}

/**
 * Redacts the value under every secret-named key in JSON-shaped text by walking the text's string
 * literals, rather than by matching the shape around them.
 *
 * Deliberately not a JSON parser: it never validates the document, so it works just as well on a
 * JSON fragment quoted inside a log line, a body truncated mid-flight, or an object printed with
 * trailing commas — all things a trace really contains and `JSON.parse` would reject outright,
 * taking the redaction down with it. It tracks exactly two things: where string literals start and
 * end, and whether the literal it just passed was a key with a secret-carrying name.
 *
 * Every span it does not redact is copied through byte-identical, original escaping included. A
 * string value that itself decodes to JSON is re-scanned one level down and spliced back
 * re-escaped ONLY if that rescan changed something, so ordinary content never has its escaping
 * normalised behind a reader's back.
 *
 * It will occasionally redact prose that quotes a `"token": "…"` snippet where nothing secret was
 * involved. That is the safe direction for a redactor and it is accepted knowingly: the cost is
 * one unreadable phrase in a rationale, against a credential on disk.
 *
 * ## Why the walk runs twice
 *
 * `walkJsonLiterals` pairs quotes as it meets them: the first with the second, the third with the
 * fourth. One unbalanced double quote anywhere earlier in the text shifts that pairing by one for
 * everything after it, so keys are read as values and values as keys and nothing is recognised at
 * all. Measured against the real function, every one of these printed the credential in full:
 *
 *     LEAKS  parse failed at " -> {"token":"SECRET"}
 *     LEAKS  SyntaxError: Unexpected token " in JSON at position 3. Body was {"token":"SECRET"}
 *     LEAKS  <meta charset="utf-8"><p>err</p>" {"token":"SECRET"}
 *     LEAKS  " {"token":"SECRET"} "
 *
 * An error message quoting the malformed body it choked on is exactly where a credential turns up,
 * so giving up on the first odd quote failed in the case the walk was most needed for.
 *
 * Three candidate rules were weighed. Recovering at the point of failure does not work: the parity
 * is already wrong long before the walk notices, and in the first three cases above it only notices
 * at the very last quote. Treating unbalanced text as wholly unparseable and redacting all of it is
 * honest but useless — a trace of a failed request would become one `[REDACTED]`, and the channel
 * exists to show what came back. What is left is the observation that makes both unnecessary: a
 * real JSON string literal is delimited by two ADJACENT unescaped quotes, and one of the two
 * parities pairs any given adjacent couple. So the walk runs once from the start and once from just
 * past the first quote, and every literal in the text is read correctly by one pass or the other,
 * however many stray quotes there are and wherever they sit. The second pass reads the first pass's
 * output, which is safe because every replacement this function writes preserves quote parity
 * (a quoted value becomes a quoted `[REDACTED]`, a bare one a bare `[REDACTED]`).
 *
 * The cost is one extra linear pass. The cost of a false positive — a wrong-parity pairing whose
 * contents happen to spell a secret key name followed by a colon — is one over-redacted span in
 * text that was already malformed, which is the direction this module errs in on purpose.
 */
function redactJsonShapedText(text: string, depth: number): string {
  if (!text.includes('"')) return text;
  const firstParity = walkJsonLiterals(text, depth, 0);
  const firstQuote = firstParity.indexOf('"');
  if (firstQuote === -1) return firstParity;
  return walkJsonLiterals(firstParity, depth, firstQuote + 1);
}

/**
 * One pass of the literal walk, starting at `from` — everything before it is copied through and
 * never examined, which is how the caller above asks for the opposite quote parity.
 */
function walkJsonLiterals(text: string, depth: number, from: number): string {
  let out = '';
  let copyFrom = 0;
  let i = from;
  let pendingSecretKey = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '"') {
      const end = endOfStringLiteral(text, i);
      if (end === -1) {
        // The text stops inside this literal. If a secret-named key was waiting for its value, that
        // value is everything left, however much of it arrived — a body cut mid-credential
        // (`{"a":1,"token":"SECRETabc`) used to print the surviving prefix, which is still the first
        // half of a credential. Otherwise there is no structure left to trust and the tail is copied
        // through untouched; the opposite-parity pass above gets its own look at it.
        if (pendingSecretKey) {
          out += `${text.slice(copyFrom, i)}"${REDACTED}"`;
          copyFrom = text.length;
        }
        break;
      }
      const literal = text.slice(i, end + 1);
      const decoded = decodeStringLiteral(literal);
      if (followedByColon(text, end + 1)) {
        pendingSecretKey = decoded !== undefined && isSecretKeyName(decoded);
      } else if (pendingSecretKey) {
        out += `${text.slice(copyFrom, i)}"${REDACTED}"`;
        copyFrom = end + 1;
        pendingSecretKey = false;
      } else if (decoded !== undefined && depth < MAX_NESTED_TEXT_DEPTH && worthRescanning(literal, decoded)) {
        const inner = redactAtDepth(decoded, depth + 1);
        if (inner !== decoded) {
          out += text.slice(copyFrom, i) + JSON.stringify(inner);
          copyFrom = end + 1;
        }
      }
      i = end + 1;
      continue;
    }

    if (pendingSecretKey && ch !== ':' && !isJsonWhitespace(ch)) {
      pendingSecretKey = false;

      // A secret-named key covers EVERYTHING beneath it, not only a scalar sitting directly under
      // it. Binding the key to a bare value only was the severest of the six holes an adversarial
      // pass found, because the contents of a container were then judged by their own key names and
      // those do not have to be secret-named at all. Measured against the real function:
      //
      //     LEAKS  {"token":["SECRET"]}
      //     LEAKS  {"token":{"value":"SECRET"}}
      //     LEAKS  {"token":[{"v":"SECRET"}]}
      //     LEAKS  {"credentials":{"user":"u","pass":"SECRET"}}
      //
      // The last one is the shape a credential object actually arrives in, and `pass` matches no
      // suffix in `SECRET_KEY_SUFFIXES` — naming the container `credentials` was the only signal
      // present and it was the one being discarded. The whole container is replaced, members that
      // were harmless included: a key that says its subtree is a credential is a better signal than
      // any guess about which part of that subtree is the secret half.
      if (ch === '{' || ch === '[') {
        const end = endOfContainer(text, i);
        out += `${text.slice(copyFrom, i)}"${REDACTED}"`;
        copyFrom = end;
        i = end;
        continue;
      }

      const end = endOfBareValue(text, i);
      if (end > i && !BARE_JSON_LITERALS.has(text.slice(i, end))) {
        out += text.slice(copyFrom, i) + REDACTED;
        copyFrom = end;
        i = end;
        continue;
      }
      // One of JSON's bare words: this key has no value of its own worth redacting.
    }

    if (ch === '{' || ch === '[' || ch === ',') pendingSecretKey = false;
    i += 1;
  }

  return copyFrom === 0 ? text : out + text.slice(copyFrom);
}

/**
 * Exported for `apiTrace.ts`'s request/response body tracing (`codeVerdict.trace.api`): that
 * channel logs full body content no other path in this codebase reads, and per this module's own
 * standing rule — reuse the one redactor, never write a second one — it calls this directly rather
 * than going through `sanitizePublicText`, whose 240-character cap and whitespace-collapsing would
 * mutilate a full JSON payload the whole point is to show intact. Redaction is the only guarantee
 * this function makes; length-bounding a body that might be arbitrarily large is that caller's own
 * job (see `apiTrace.ts`'s own "bytes omitted" comment).
 *
 * Three layers run in the order set out at the top of this file — known values, then structure,
 * then patterns. The order is the point: a registered value is gone before anything tries to
 * reason about the syntax around it, and the patterns run last over whatever the first two left,
 * rather than being the thing relied upon.
 */
export function redactSecrets(text: string): string {
  return redactAtDepth(text, 0);
}

function redactAtDepth(text: string, depth: number): string {
  const withKnownValues = redactRegisteredValues(text);
  const withStructure = redactJsonShapedText(withKnownValues, depth);
  const withKeyedRedacted = withStructure.replace(
    KEYED_SECRET_PATTERN,
    (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  );
  return STANDALONE_SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, REDACTED), withKeyedRedacted);
}

// Control characters have no business in a one-line public label; stripping them defends against
// escape-sequence/log injection into an output channel or webview.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Fails closed: anything that is not a non-empty string after cleaning
 * returns `undefined`, so a caller (the builder) can refuse to append the
 * event rather than store something guessed.
 *
 * Redact, THEN bound — never the other way round, which is how this function used to run. It
 * truncated the input to a 10,000-character scan cap first and redacted what was left, so a
 * credential straddling the cut had its surviving prefix printed. Measured against the real
 * function, with the value registered:
 *
 *     sanitizePublicText("\n"×9,985 + "x " + SECRETabcdefgh1234567890)  ->  "x SECRETabcdefg"
 *
 * The leading whitespace collapses away afterwards, which is what pulls the fragment into the
 * visible 240 characters — so the cap was not even keeping the surviving half off screen. The cap
 * existed to bound CPU, and dropping it costs nothing worth having: `redactSecrets` is linear in
 * its input (two single passes for the structural layer, bounded quantifiers with no nested
 * repetition in the pattern layer, timed in this module's own test against a 120 KB unbroken
 * identifier run). A cut that can split a credential in half is a worse failure than a scan that
 * is proportional to what it was handed. `apiTrace.ts` — the caller with genuinely unbounded input
 * — has always redacted first and bounded after for the same reason.
 */
export function sanitizePublicText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const redacted = redactSecrets(raw).replace(CONTROL_CHARS, '');
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_PUBLIC_TEXT_LENGTH ? `${collapsed.slice(0, MAX_PUBLIC_TEXT_LENGTH - 1)}…` : collapsed;
}

export type SanitizedMetadataValue = string | number | boolean;
export type SanitizedMetadata = Readonly<Record<string, SanitizedMetadataValue>>;

/**
 * Keys whose value is raw model or tool content — not a credential, and not a question this
 * module's credential rules can answer. A prompt, a model reply, hidden reasoning, a full tool
 * argument list or a command's whole stdout is prohibited from a public metadata record because of
 * what it IS, regardless of whether anything inside it looks like a secret, so it is dropped whole
 * rather than redacted in place. That is a different job from `isSecretKeyName` and it is the
 * reason a second list still exists here at all.
 *
 * What used to be here as well — `token`, `secret`, `password`, `apikey`, `accesskey`,
 * `clientsecret`, `authorization`, `cookie` — was the exact-match enumeration of credential names
 * that this module's own header gives as the approach that kept failing, still running one level
 * down. It failed here in exactly the predicted way; measured against the real function:
 *
 *     LEAKS  {"refresh_token":"SECRET"}
 *     LEAKS  {"githubToken":"SECRET"}
 *     LEAKS  {"x-api-key":"SECRET"}
 *     LEAKS  {"credentials":{"user":"u","pass":"SECRET"}}
 *
 * A missed key name is not a partial failure here: the value then reaches `sanitizePublicText` as
 * a bare string with no key context at all, so a credential with no scheme word and no pattern
 * beside it has nothing left to catch it. Those names are gone from this list; `isSecretKeyName`
 * — suffix-matched, case- and punctuation-insensitive — now answers the credential question for
 * metadata keys exactly as it does for JSON keys, and covers every spelling above.
 *
 * Matched as a SUFFIX, for the same reason: `rawPrompt`, `systemPrompt`, `modelResponse` and
 * `toolOutput` are all the key this is trying to catch. `message` deliberately does not match
 * `messages` — `sanitizeErrorReason` reads `metadata.message`, and a one-line error message is the
 * public fact this module exists to let through.
 */
const RAW_CONTENT_KEY_SUFFIXES: readonly string[] = [
  'prompt',
  'response',
  'messages',
  'reasoning',
  'chainofthought',
  'thinking',
  'arguments',
  'args',
  'output',
  'stdout',
  'stderr',
  'rawtext',
];

function isRawContentKeyName(name: string): boolean {
  const normalized = normalizedKey(name);
  if (normalized.length === 0) return false;
  return RAW_CONTENT_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

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
    // Both tests are on the KEY, and both drop the whole subtree rather than descending into it:
    // a container under a credential-named key is covered exactly as the structural walk covers
    // one in JSON, so `{credentials: {user, pass}}` loses `pass` without anyone having had to
    // guess that `pass` was the secret half.
    if (isSecretKeyName(key) || isRawContentKeyName(key)) continue;
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

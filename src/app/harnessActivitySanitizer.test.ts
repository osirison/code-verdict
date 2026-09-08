import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecretValues,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_ENTRIES,
  MAX_PUBLIC_TEXT_LENGTH,
  MIN_REGISTERED_SECRET_LENGTH,
  redactSecrets,
  registerSecretValue,
  sanitizeErrorReason,
  sanitizeMetadata,
  sanitizePublicText,
} from './harnessActivitySanitizer';

// The registry is module state shared by every test in this file: a value registered by one case
// would otherwise redact its way through the next one's assertions and make a green run mean
// nothing.
afterEach(clearRegisteredSecretValues);

describe('sanitizePublicText (task 5.5)', () => {
  it('fails closed on a non-string value', () => {
    expect(sanitizePublicText(123)).toBeUndefined();
    expect(sanitizePublicText(undefined)).toBeUndefined();
    expect(sanitizePublicText({ message: 'hi' })).toBeUndefined();
  });

  it('fails closed on an empty or whitespace-only string', () => {
    expect(sanitizePublicText('')).toBeUndefined();
    expect(sanitizePublicText('   \n\t  ')).toBeUndefined();
  });

  it('redacts a Bearer token', () => {
    const result = sanitizePublicText('Auth failed: Bearer sk-abc123DEF456ghi789JKL for repo fetch');
    expect(result).not.toContain('sk-abc123DEF456ghi789JKL');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a GitHub personal access token', () => {
    const result = sanitizePublicText('leaked ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa in output');
    expect(result).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
  });

  it('redacts a GitLab personal access token', () => {
    const result = sanitizePublicText('token was glpat-aaaaaaaaaaaaaaaaaaaa here');
    expect(result).not.toMatch(/glpat-[a-zA-Z0-9_-]{20,}/);
  });

  it('redacts an AWS access key id', () => {
    const result = sanitizePublicText('found AKIAABCDEFGHIJKLMNOP in a config file');
    expect(result).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('redacts a keyed secret while keeping the key name for context', () => {
    const result = sanitizePublicText('request failed, api_key=abcdef1234567890 rejected');
    expect(result).not.toContain('abcdef1234567890');
    expect(result).toContain('api_key');
    expect(result).toContain('[REDACTED]');
  });

  it('does not redact ordinary prose that merely mentions a secret-related word', () => {
    expect(sanitizePublicText('Checked whether the access token had expired')).toBe(
      'Checked whether the access token had expired',
    );
  });

  it('strips control characters and collapses internal whitespace/newlines', () => {
    const result = sanitizePublicText('line one\nline\ttwo\u0007 bell');
    expect(result).toBe('line one line two bell');
  });

  it('truncates text longer than the concise-text bound', () => {
    const long = 'x'.repeat(MAX_PUBLIC_TEXT_LENGTH + 100);
    const result = sanitizePublicText(long)!;
    expect(result.length).toBe(MAX_PUBLIC_TEXT_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('redactSecrets (exported for apiTrace.ts body tracing)', () => {
  // Regression for a real leak this change found: the keyed pattern's value class stops at the
  // first space, so on an `Authorization: Bearer <token>` header rendered as text it used to
  // capture only the word "Bearer" as the "secret", redact that, and leave the actual token typed
  // out in full right after it.
  it('redacts an Authorization header carrying a Bearer token, the token included', () => {
    const result = redactSecrets('Authorization: Bearer sk-live-SECRETSECRETSECRET1234567890');
    expect(result).not.toContain('SECRETSECRETSECRET1234567890');
    expect(result).not.toContain('Bearer');
    expect(result).toBe('Authorization: [REDACTED]');
  });

  it('redacts a PRIVATE-TOKEN header', () => {
    const result = redactSecrets('PRIVATE-TOKEN: glpat-SECRETSECRETSECRET1234567890');
    expect(result).not.toContain('SECRETSECRETSECRET1234567890');
    expect(result).toBe('PRIVATE-TOKEN: [REDACTED]');
  });

  it('still redacts a standalone Bearer token with no keyed prefix at all', () => {
    const result = redactSecrets('Bearer sk-live-abcdefghijklmnop1234 was leaked in the logs');
    expect(result).not.toContain('abcdefghijklmnop1234');
  });

  // The same leak again, in the scheme this codebase started composing on
  // 2026-09-09. A git fetch authenticates with `Basic base64("<user>:<token>")`
  // — a bearer token is not accepted by either forge's git transport — so an
  // Authorization header rendered as text now says `Basic` where it said
  // `Bearer`, the value class stops at that space just as it did then, and the
  // encoded credential would be typed out in full right after the `[REDACTED]`.
  // The encoding is not protection: it decodes with one call.
  it('redacts an Authorization header carrying a Basic credential, the credential included', () => {
    const credential = Buffer.from('x-access-token:gho_SECRETSECRETSECRET1234', 'utf8').toString('base64');
    const result = redactSecrets(`Authorization: Basic ${credential}`);
    expect(result).not.toContain(credential);
    expect(result).toBe('Authorization: [REDACTED]');
  });

  it('still redacts a standalone Basic credential with no keyed prefix at all', () => {
    const credential = Buffer.from('oauth2:glpat-SECRETSECRETSECRET1234', 'utf8').toString('base64');
    const result = redactSecrets(`Basic ${credential} was leaked in the logs`);
    expect(result).not.toContain(credential);
  });
});

describe('sanitizeMetadata (task 5.5, recursive allowlist)', () => {
  it('keeps allowlisted primitive leaves and drops everything else', () => {
    const metadata = sanitizeMetadata({
      code: 'rateLimited',
      retryAfterSeconds: 30,
      retryable: true,
      handler: () => undefined,
    });
    expect(metadata).toEqual({ code: 'rateLimited', retryAfterSeconds: 30, retryable: true });
  });

  it('recurses into nested objects and arrays with dotted-path keys', () => {
    const metadata = sanitizeMetadata({
      cause: { provider: 'github', details: { status: 429 } },
      hints: ['slow down'],
    });
    expect(metadata['cause.provider']).toBe('github');
    expect(metadata['cause.details.status']).toBe(429);
    expect(metadata['hints.0']).toBe('slow down');
  });

  it('drops a denylisted key entirely at any depth instead of redacting its value', () => {
    const metadata = sanitizeMetadata({ code: 'failed', cause: { prompt: 'full system prompt text...' } });
    expect(metadata.prompt).toBeUndefined();
    expect(metadata['cause.prompt']).toBeUndefined();
    expect(Object.keys(metadata)).not.toContain('cause.prompt');
  });

  it('redacts a secret found inside a nested string leaf', () => {
    const metadata = sanitizeMetadata({ detail: 'failed with token=abcdef1234567890' });
    expect(metadata.detail).not.toContain('abcdef1234567890');
  });

  it('bounds recursion depth so content beyond the limit is dropped', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { marker: 'unique-deep-marker-xyz' } } } } } };
    const metadata = sanitizeMetadata(deep);
    expect(JSON.stringify(metadata)).not.toContain('unique-deep-marker-xyz');
  });

  it('does not loop forever or throw on a circular reference', () => {
    const circular: Record<string, unknown> = { code: 'x' };
    circular.self = circular;
    expect(() => sanitizeMetadata(circular)).not.toThrow();
  });

  it('bounds the number of entries produced from a very wide object', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) wide[`field${i}`] = i;
    const metadata = sanitizeMetadata(wide);
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(MAX_METADATA_ENTRIES);
  });

  it('bounds how many array items it walks', () => {
    const many = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const metadata = sanitizeMetadata({ list: many });
    const keys = Object.keys(metadata).filter((key) => key.startsWith('list.'));
    expect(keys.length).toBeLessThanOrEqual(MAX_METADATA_ARRAY_ITEMS);
  });
});

describe('sanitizeErrorReason (task 5.5)', () => {
  it('sanitizes a plain string error', () => {
    expect(sanitizeErrorReason('token=abcdef1234567890 rejected')).not.toContain('abcdef1234567890');
  });

  it('extracts and sanitizes an Error instance message', () => {
    expect(sanitizeErrorReason(new Error('rate limited, Bearer sk-abc123DEF456ghi789JKL'))).not.toMatch(
      /sk-abc123DEF456ghi789JKL/,
    );
  });

  it('extracts a message field from an error-shaped object', () => {
    expect(sanitizeErrorReason({ message: 'unavailable: revision not found', code: 'notFound' })).toBe(
      'unavailable: revision not found',
    );
  });

  it('falls back to a generic message for an unrecognized shape', () => {
    expect(sanitizeErrorReason(42)).toBe('an unexpected error occurred');
    expect(sanitizeErrorReason({ weird: true })).toBe('an unexpected error occurred');
  });
});

/**
 * The third hole in this one function in a single day, and the reason the approach under it
 * changed rather than gaining a fourth alternative (see the module's own header).
 *
 * Every case below was measured against the real function before the fix: the whole first group
 * printed the secret back verbatim, because the keyed pattern wants the key name followed by `:`
 * or `=` and a quoted JSON key has a closing quote in between. It matters because `apiTrace.ts`
 * routes whole request/response bodies through `redactSecrets` under `codeVerdict.trace.api`, and
 * a JSON body is exactly the shape a credential arrives in.
 *
 * The secret is one constant so a single `not.toContain` per case is the whole assertion: these
 * tests are about whether the value escapes, not about how the surviving text is punctuated.
 */
describe('redactSecrets: a secret written as a quoted JSON field', () => {
  const SECRET = 'SECRETabcdefgh1234567890';

  const leakingShapes: readonly (readonly [string, string])[] = [
    ['the plain quoted field the trace actually leaked', `{"token":"${SECRET}"}`],
    ['whitespace around the colon', `{"token" : "${SECRET}"}`],
    ['a camelCase key', `{"apiKey":"${SECRET}"}`],
    ['a key in a different case', `{"TOKEN":"${SECRET}"}`],
    ['a hyphenated key', `{"private-token":"${SECRET}"}`],
    ['a key spelled with a unicode escape', `{"\\u0074oken":"${SECRET}"}`],
    ['nesting', `{"cause":{"auth":{"password":"${SECRET}"}}}`],
    ['an array of objects', `[{"client_secret":"${SECRET}"},{"unrelated":1}]`],
    ['an escaped quote inside the value', `{"token":"pre\\"${SECRET}"}`],
    ['a scheme word inside the value', `{"authorization":"Bearer ${SECRET}"}`],
    ['a body that is JSON inside a JSON string', `{"body":"{\\"token\\":\\"${SECRET}\\"}"}`],
    ['a field after the secret, which must survive', `{"token": "${SECRET}", "next": 1}`],
  ];

  for (const [name, text] of leakingShapes) {
    it(`redacts a secret under ${name}`, () => {
      const result = redactSecrets(text);
      expect(result).not.toContain(SECRET);
      expect(result).toContain('[REDACTED]');
    });
  }

  // The classic string-scanner bug: treating the `"` in `…\\"` as escaped, when the backslash
  // before it was itself escaped. Getting this wrong ends the literal in the wrong place and
  // drags the rest of the document inside it, which silently stops redacting everything after.
  it('ends a string literal correctly when the value ends with an escaped backslash', () => {
    const text = `{"token":"ends with a backslash \\\\","apiKey":"${SECRET}"}`;
    expect(redactSecrets(text)).not.toContain(SECRET);
  });

  it('keeps the key name, so a trace can still say which credential was involved', () => {
    expect(redactSecrets(`{"apiKey":"${SECRET}"}`)).toBe('{"apiKey":"[REDACTED]"}');
  });

  it('redacts an unquoted value under a secret-named key, since near-JSON is what a log line holds', () => {
    expect(redactSecrets('{"token":1234567890}')).toBe('{"token":[REDACTED]}');
  });

  it('leaves JSON\'s bare words alone: a null credential is not a secret, and redacting it only hides why', () => {
    expect(redactSecrets('{"token":null,"password":false}')).toBe('{"token":null,"password":false}');
  });

  it('copies an ordinary body through byte-identical, formatting and all', () => {
    const body = '{\n  "items": [ {"id": 1.50, "name": "a \\"quoted\\" name"} ],\n  "total": 10000000000000001\n}';
    expect(redactSecrets(body)).toBe(body);
  });
});

/**
 * Found while fixing the one above, and measured the same way: `\b` cannot match between `_` and
 * `t`, so a bare `token` alternative never matched a key name that merely ENDS in one. Before the
 * fix, `refresh_token=…`, `refreshToken=…`, `GITHUB_TOKEN=…` and `session_secret: …` all printed
 * the secret in full, while `x-api-key: …` was redacted — the difference being nothing more than
 * which of the alternatives happened to start at a word boundary.
 */
describe('redactSecrets: a key name that merely ends in a secret word', () => {
  const SECRET = 'SECRETabcdefgh1234567890';

  for (const text of [
    `refresh_token=${SECRET}`,
    `refreshToken=${SECRET}`,
    `GITHUB_TOKEN=${SECRET}`,
    `session_secret: ${SECRET}`,
    `gitlab.api_key=${SECRET}`,
    `{"refresh_token":"${SECRET}"}`,
  ]) {
    it(`redacts ${text.split(/[=:]/)[0]}`, () => {
      expect(redactSecrets(text)).not.toContain(SECRET);
    });
  }

  it('still leaves ordinary prose alone, which is what the value class and the required separator are for', () => {
    expect(redactSecrets('The refresh token had already expired')).toBe('The refresh token had already expired');
  });
});

/**
 * The layer that does not depend on shape at all, and the reason the pattern could be demoted.
 *
 * `./connections.ts` registers the credential for every pod it builds one for, at the single point
 * where either kind becomes a value the rest of the code can hold. A registered value is removed
 * wherever it appears, so a channel that invents a syntax nobody anticipated cannot leak it — the
 * cases below are all syntaxes no pattern in this file matches.
 */
describe('redactSecrets: values the host actually holds', () => {
  const HELD = 'zX9-held-credential-value-42';

  it('redacts a held credential in a syntax no pattern here knows', () => {
    registerSecretValue(HELD);
    expect(redactSecrets(`<token>${HELD}</token>`)).toBe('<token>[REDACTED]</token>');
    expect(redactSecrets(`credential:\n  ${HELD}\n`)).not.toContain(HELD);
    expect(redactSecrets(`the run failed while using ${HELD} against the host`)).not.toContain(HELD);
  });

  it('redacts a held credential that has been base64 or percent encoded on its way into the text', () => {
    registerSecretValue(HELD);
    const base64 = Buffer.from(HELD, 'utf8').toString('base64');
    const base64Url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(redactSecrets(`{"blob":"${base64}"}`)).not.toContain(base64);
    expect(redactSecrets(`opaque ${base64Url} value`)).not.toContain(base64Url);
    expect(redactSecrets(`https://host.test/x?q=${encodeURIComponent(HELD)}`)).not.toContain(HELD);
  });

  // Found by review after the first three layers were in place, and it defeated all three: with the
  // value registered, spelling one character of it as a unicode escape means the raw bytes are
  // nowhere in the text, the canonical JSON escaping of the value is the value itself, and the key
  // it sits under is not secret-named, so nothing decoded it and nothing looked. The structural
  // walk now re-scans any literal that contains an escape at all, precisely because an escape means
  // the bytes in the text are not the bytes of the value.
  it('redacts a held credential hidden behind a unicode escape under an innocent key', () => {
    registerSecretValue(HELD);
    const escaped = `{"note":"\\u007a${HELD.slice(1)}"}`;
    expect(escaped).not.toContain(HELD); // the escaping really did put the raw form out of reach
    expect(redactSecrets(escaped)).not.toContain(HELD.slice(1));
  });

  it('redacts a held credential whose JSON escaping makes it a different string in the text', () => {
    const awkward = 'held"secret\\value-42';
    registerSecretValue(awkward);
    const embedded = JSON.stringify({ note: awkward });
    expect(embedded).not.toContain(awkward); // the escaping really did change the bytes
    expect(redactSecrets(embedded)).not.toContain(JSON.stringify(awkward).slice(1, -1));
  });

  it('ignores a value too short to redact globally without shredding ordinary text', () => {
    const tiny = 'a'.repeat(MIN_REGISTERED_SECRET_LENGTH - 1);
    registerSecretValue(tiny);
    expect(redactSecrets(`a banana is ${tiny} thing`)).toContain(tiny);
  });

  it('ignores a non-string, so no caller has to guard before calling', () => {
    expect(() => {
      registerSecretValue(undefined);
      registerSecretValue(42);
      registerSecretValue({ token: 'x' });
    }).not.toThrow();
  });

  it('forgets everything on clear, which is what keeps one test from redacting the next one\'s text', () => {
    registerSecretValue(HELD);
    clearRegisteredSecretValues();
    expect(redactSecrets(`plain ${HELD} text`)).toContain(HELD);
  });

  // The limit this module states in its own header, asserted rather than claimed — and measured,
  // because the first version of this test claimed the wrong thing. Whether the registry
  // recognises a composed `Basic` credential is pure base64 alignment: the encoding of
  // `<username>:<token>` contains the encoding of the token by itself only when the bytes before
  // the token divide by three.
  it('covers a composed Basic credential by pattern, and by the registry only when the base64 aligns', () => {
    registerSecretValue(HELD);
    const tokenAlone = Buffer.from(HELD, 'utf8').toString('base64');

    // `x-access-token:` is 15 bytes, a multiple of 3, so the pair's encoding ends with the token's
    // own encoding and the registry finds it even with the scheme word stripped off.
    const aligned = Buffer.from(`x-access-token:${HELD}`, 'utf8').toString('base64');
    expect(aligned).toContain(tokenAlone);
    expect(redactSecrets(`Authorization: Basic ${aligned}`)).toBe('Authorization: [REDACTED]');
    expect(redactSecrets(`blob ${aligned}`)).not.toContain(tokenAlone);

    // `oauth2:` is 7 bytes, so nothing the registry holds appears anywhere in the encoding. The
    // standalone pattern is then the whole defence, and it works because `Basic ` is still
    // attached — strip that and the credential survives. That is the documented limit, asserted
    // rather than described.
    const misaligned = Buffer.from(`oauth2:${HELD}`, 'utf8').toString('base64');
    expect(misaligned).not.toContain(tokenAlone);
    expect(redactSecrets(`Authorization: Basic ${misaligned}`)).toBe('Authorization: [REDACTED]');
    expect(redactSecrets(`blob ${misaligned}`)).toContain(misaligned);
  });
});

/**
 * The keyed pattern grew a bounded prefix on its name group, and the structural walk is a
 * character-at-a-time pass; both run over whole traced bodies, which `apiTrace.ts` caps at 100 KB.
 * An unbroken run of identifier characters is the input that would expose backtracking in the
 * first, and a large well-formed body is the one that would expose accidental quadratic work in
 * the second. Generous bounds — this asserts "not pathological", not a benchmark.
 */
describe('redactSecrets: cost on the largest input a caller really passes', () => {
  it('stays fast on a 120 KB unbroken identifier run and on a 100 KB JSON body', () => {
    const identifierRun = 'aB9_x-'.repeat(20_000);
    const startedRun = Date.now();
    redactSecrets(identifierRun);
    expect(Date.now() - startedRun).toBeLessThan(2_000);

    const body = `{"items":[${Array.from(
      { length: 2_000 },
      (_, i) => `{"id":${i},"name":"n${i}","url":"https://h.test/x?a=b"}`,
    ).join(',')}]}`;
    expect(body.length).toBeGreaterThan(90_000);
    const startedBody = Date.now();
    redactSecrets(body);
    expect(Date.now() - startedBody).toBeLessThan(2_000);

    // The escape-heavy case specifically, because an escape is what now triggers the one-level
    // rescan: a body of diff hunks, every value carrying newlines and quotes, is the ordinary
    // shape of this extension's own traffic and the one that pays for that rescan on every field.
    const escaped = JSON.stringify({
      files: Array.from({ length: 1_000 }, (_, i) => ({
        path: `src/f${i}.ts`,
        patch: '@@ -1,2 +1,2 @@\n-const a = "old";\n+const a = "new";\n',
      })),
    });
    expect(escaped.length).toBeGreaterThan(90_000);
    const startedEscaped = Date.now();
    redactSecrets(escaped);
    expect(Date.now() - startedEscaped).toBeLessThan(2_000);
  });

  /**
   * `sanitizePublicText` used to truncate its input to 10,000 characters before redacting, and the
   * justification for removing that cut is that the redaction it feeds is linear. Asserted here
   * rather than argued in a comment: half a megabyte is far past any rationale, summary or error
   * message a caller really passes, and the bound is generous enough that this reads as "not
   * pathological", not as a benchmark.
   */
  it('stays fast on a 500 KB input now that nothing is cut before redaction', () => {
    const started = Date.now();
    sanitizePublicText('x'.repeat(500_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/**
 * The adversarial pass that followed the structural layer landing. Every case below was measured
 * against the real exported function before the fix, and every one of them printed the credential
 * in full. They are grouped by the property each one breaks, because the fixes are different.
 *
 * Shared secret, one `not.toContain` per case: these tests are about whether the value escapes,
 * never about how the surviving text is punctuated.
 */
const ADVERSARIAL_SECRET = 'SECRETabcdefgh1234567890';

/**
 * Hole 1, the severest of the six: the walk bound a secret-named key to a SCALAR only. The moment
 * the value opened a container the binding was dropped and everything inside was judged by its own
 * key names, none of which had to be secret-named at all:
 *
 *     LEAKS  {"token":["SECRET"]}
 *     LEAKS  {"token":{"value":"SECRET"}}
 *     LEAKS  {"token":[{"v":"SECRET"}]}
 *     LEAKS  {"secret":["SECRET"]}
 *     LEAKS  {"credentials":{"user":"u","pass":"SECRET"}}
 *
 * The last one is the shape a real credential object arrives in, and `pass` matches no suffix in
 * `SECRET_KEY_SUFFIXES` — so naming the container `credentials` was the only signal present, and
 * it was the one being thrown away. A secret-named key now covers everything beneath it.
 */
describe('redactSecrets: a container under a secret-named key', () => {
  const leakingShapes: readonly (readonly [string, string])[] = [
    ['an array', `{"token":["${ADVERSARIAL_SECRET}"]}`],
    ['an object', `{"token":{"value":"${ADVERSARIAL_SECRET}"}}`],
    ['an array of objects', `{"token":[{"v":"${ADVERSARIAL_SECRET}"}]}`],
    ['an array under a different secret word', `{"secret":["${ADVERSARIAL_SECRET}"]}`],
    ['an object whose own members are innocently named', `{"credentials":{"user":"u","pass":"${ADVERSARIAL_SECRET}"}}`],
    ['three containers deep under one secret key', `{"token":{"a":[{"b":{"c":"${ADVERSARIAL_SECRET}"}}]}}`],
    ['a secret-named key three containers down', `{"a":{"b":[{"token":{"c":"${ADVERSARIAL_SECRET}"}}]}}`],
    ['a container the body never closes', `{"token":{"value":"${ADVERSARIAL_SECRET}"`],
  ];

  for (const [name, text] of leakingShapes) {
    it(`redacts ${name} under a secret-named key`, () => {
      const result = redactSecrets(text);
      expect(result).not.toContain(ADVERSARIAL_SECRET);
      expect(result).toContain('[REDACTED]');
    });
  }

  it('replaces the whole container and nothing beside it', () => {
    expect(redactSecrets('{"token":["a","b"],"next":1}')).toBe('{"token":"[REDACTED]","next":1}');
    expect(redactSecrets('{"before":1,"token":{"a":{"b":2}},"after":3}')).toBe(
      '{"before":1,"token":"[REDACTED]","after":3}',
    );
  });

  it('leaves a container under an ordinary key completely alone', () => {
    const body = '{"items":[{"id":1},{"id":2}],"total":2}';
    expect(redactSecrets(body)).toBe(body);
  });
});

/**
 * Hole 2: one unbalanced double quote shifted the parity of every literal after it, so the walk
 * read keys as values and values as keys and redacted nothing:
 *
 *     LEAKS  parse failed at " -> {"token":"SECRET"}
 *     LEAKS  SyntaxError: Unexpected token " in JSON at position 3. Body was {"token":"SECRET"}
 *     LEAKS  <meta charset="utf-8"><p>err</p>" {"token":"SECRET"}
 *     LEAKS  {"a":1,"token":"SECRET            (cut mid-value)
 *
 * An error message quoting the malformed body it rejected is exactly where a credential turns up,
 * so a walk that gives up on the first odd quote failed in the case it was most needed. The last
 * case is not a parity problem at all but the same symptom: an unterminated value under a
 * secret-named key was copied through untouched.
 */
describe('redactSecrets: text whose quotes do not balance', () => {
  const leakingShapes: readonly (readonly [string, string])[] = [
    ['a parser message quoting the character it choked on', `parse failed at " -> {"token":"${ADVERSARIAL_SECRET}"}`],
    [
      'a SyntaxError quoting the body it rejected',
      `SyntaxError: Unexpected token " in JSON at position 3. Body was {"token":"${ADVERSARIAL_SECRET}"}`,
    ],
    ['an HTML error page with a stray quote in front of the body', `<meta charset="utf-8"><p>err</p>" {"token":"${ADVERSARIAL_SECRET}"}`],
    ['a body cut off mid-value', `{"a":1,"token":"${ADVERSARIAL_SECRET}`],
    ['two stray quotes, so the count is even and only the parity is wrong', `" {"token":"${ADVERSARIAL_SECRET}"} "`],
    ['a stray quote after the credential rather than before it', `{"token":"${ADVERSARIAL_SECRET}"} trailing " quote`],
  ];

  for (const [name, text] of leakingShapes) {
    it(`redacts a secret in ${name}`, () => {
      const result = redactSecrets(text);
      expect(result).not.toContain(ADVERSARIAL_SECRET);
      expect(result).toContain('[REDACTED]');
    });
  }

  /**
   * A response body is cut wherever the transport stopped, which can be any byte of a credential.
   * Every prefix of the secret must be gone, not merely the whole value — a half-printed token is
   * still a token's first half. The single byte at the cut is included deliberately: there is no
   * length below which a fragment becomes safe to print.
   */
  it('prints no prefix of the credential at any truncation offset through it', () => {
    const body = `{"a":1,"token":"${ADVERSARIAL_SECRET}","b":2}`;
    const secretStart = body.indexOf(ADVERSARIAL_SECRET);
    const survivors: string[] = [];
    for (let cut = secretStart + 1; cut <= secretStart + ADVERSARIAL_SECRET.length; cut += 1) {
      const fragment = ADVERSARIAL_SECRET.slice(0, cut - secretStart);
      if (redactSecrets(body.slice(0, cut)).includes(fragment)) survivors.push(`cut at ${cut}: ${fragment}`);
    }
    expect(survivors).toEqual([]);
  });

  /**
   * The same sweep against a credential the host holds sitting under a key name that says nothing
   * at all — `"note"`, not `"token"` — so the structural walk's redact-to-end rule cannot help and
   * the known-value layer is the only thing left. Its needle match is exact, so before this fix a
   * value cut in half stopped being a needle and 23 of the 24 offsets printed a prefix.
   */
  it('prints no prefix of a HELD credential truncated under an ordinary key name', () => {
    const held = 'zX9-held-credential-value-42';
    registerSecretValue(held);
    const body = `{"a":1,"note":"${held}","b":2}`;
    const secretStart = body.indexOf(held);
    const survivors: string[] = [];
    for (let cut = secretStart + 1; cut <= secretStart + held.length; cut += 1) {
      const fragment = held.slice(0, cut - secretStart);
      if (fragment.length < 8) continue; // below the registration floor; see the case below
      if (redactSecrets(body.slice(0, cut)).includes(fragment)) survivors.push(`cut at ${cut}: ${fragment}`);
    }
    expect(survivors).toEqual([]);
  });

  it('leaves the first seven characters of a held credential, which is the registration floor', () => {
    const held = 'zX9-held-credential-value-42';
    registerSecretValue(held);
    expect(redactSecrets(`{"note":"${held.slice(0, 7)}`)).toContain(held.slice(0, 7));
    expect(redactSecrets(`{"note":"${held.slice(0, 8)}`)).not.toContain(held.slice(0, 8));
  });

  it('never mistakes an ordinary tail for a truncated credential', () => {
    registerSecretValue('zX9-held-credential-value-42');
    const body = '{"a":1,"note":"an ordinary value"}';
    expect(redactSecrets(body)).toBe(body);
  });

  /**
   * The floor the pattern layer cannot go below, asserted rather than left implicit. With no JSON
   * structure at all — a bare `name=value` fragment — the keyed pattern needs four characters of
   * value before it will call something a secret, because three characters after an `=` is
   * ordinary text far more often than it is a credential. A body truncated inside the first three
   * bytes of an unstructured credential therefore prints those bytes. Nothing above this line
   * depends on that; it is stated so a reader knows it is a decision, not an oversight.
   */
  it('leaves the first three characters of an unstructured keyed value, which is the pattern layer floor', () => {
    expect(redactSecrets(`token=${ADVERSARIAL_SECRET.slice(0, 3)}`)).toContain(ADVERSARIAL_SECRET.slice(0, 3));
    expect(redactSecrets(`token=${ADVERSARIAL_SECRET.slice(0, 4)}`)).not.toContain(ADVERSARIAL_SECRET.slice(0, 4));
  });

  it('still copies a well-formed body through byte-identical, which the second parity pass must not disturb', () => {
    const body = '{\n  "items": [ {"id": 1.50, "name": "a \\"quoted\\" name"} ],\n  "total": 10000000000000001\n}';
    expect(redactSecrets(body)).toBe(body);
  });
});

/**
 * Hole 5: the keyed pattern's name group allowed at most 24 characters before the secret word, and
 * a `\b` in front of it meant the match had to start at the real beginning of the name. `_` is a
 * word character, so there is no word boundary inside `a…a_token`, and a key name longer than the
 * window escaped the pattern entirely. Measured.
 */
describe('redactSecrets: a key name longer than the pattern window', () => {
  for (const length of [25, 64, 200]) {
    it(`redacts a value under a ${length}-character prefix before the secret word`, () => {
      const name = `${'a'.repeat(length)}_token`;
      const result = redactSecrets(`${name}=${ADVERSARIAL_SECRET}`);
      expect(result).not.toContain(ADVERSARIAL_SECRET);
      // The part of the name the window could not reach is copied through, so the line still says
      // which key was involved.
      expect(result).toContain(name);
    });
  }
});

/**
 * Hole 3: `sanitizePublicText` truncated to its scan cap and redacted afterwards, so a credential
 * that straddled the cut had its surviving prefix printed. Measured against the real function:
 * with the value registered, `"\n"×9,985 + "x " + SECRET` returned `x SECRETabcdefg` — the leading
 * whitespace collapsed away afterwards, pulling the fragment into the visible 240 characters.
 */
describe('sanitizePublicText: redaction runs before any bound, never after', () => {
  it('prints no fragment of a registered credential that straddles the old scan cap', () => {
    registerSecretValue(ADVERSARIAL_SECRET);
    const result = sanitizePublicText(`${'\n'.repeat(9_985)}x ${ADVERSARIAL_SECRET}`);
    expect(result).not.toContain(ADVERSARIAL_SECRET.slice(0, 8));
    expect(result).toContain('[REDACTED]');
  });

  it('prints no fragment of a keyed credential that straddles the old scan cap', () => {
    const result = sanitizePublicText(`${'\n'.repeat(9_991)}token=${ADVERSARIAL_SECRET}`);
    expect(result).not.toContain(ADVERSARIAL_SECRET.slice(0, 3));
  });

  it('still bounds the result afterwards, so the concise-text rule is unchanged', () => {
    const result = sanitizePublicText('x'.repeat(MAX_PUBLIC_TEXT_LENGTH + 5_000))!;
    expect(result.length).toBe(MAX_PUBLIC_TEXT_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });
});

/**
 * Hole 4: `METADATA_KEY_DENYLIST` was an exact-match enumeration of key names — the approach the
 * structural layer exists because it kept failing. Its credential half missed every spelling the
 * suffix rule was written for. Measured against the real function:
 *
 *     LEAKS  {"refresh_token":"SECRET"}
 *     LEAKS  {"githubToken":"SECRET"}
 *     LEAKS  {"x-api-key":"SECRET"}
 *     LEAKS  {"credentials":{"user":"u","pass":"SECRET"}}
 *     LEAKS  {"toolOutput":"SECRET"}
 *
 * A string leaf reaching `sanitizePublicText` carries no key context at all, so a bare credential
 * under a missed key name has nothing left to catch it.
 */
describe('sanitizeMetadata: key rules that do not depend on having enumerated the name', () => {
  for (const key of ['refresh_token', 'githubToken', 'x-api-key', 'PRIVATE-TOKEN', 'client_secret', 'gitlabPrivateKey']) {
    it(`drops the value under ${key}`, () => {
      expect(JSON.stringify(sanitizeMetadata({ [key]: ADVERSARIAL_SECRET }))).not.toContain(ADVERSARIAL_SECRET);
    });
  }

  it('drops a whole container under a secret-named key, members and all', () => {
    const metadata = sanitizeMetadata({ credentials: { user: 'u', pass: ADVERSARIAL_SECRET } });
    expect(JSON.stringify(metadata)).not.toContain(ADVERSARIAL_SECRET);
    expect(Object.keys(metadata)).toEqual([]);
  });

  for (const key of ['rawPrompt', 'systemPrompt', 'modelResponse', 'toolOutput', 'fullStdout']) {
    it(`drops raw model or tool content under ${key}`, () => {
      expect(JSON.stringify(sanitizeMetadata({ [key]: 'raw blob text' }))).not.toContain('raw blob');
    });
  }

  it('keeps an ordinary fact whose name merely contains a secret word', () => {
    expect(sanitizeMetadata({ promptTokens: 412, maxTokens: 8_000, outputFormat: 'json' })).toEqual({
      promptTokens: 412,
      maxTokens: 8_000,
      outputFormat: 'json',
    });
  });
});

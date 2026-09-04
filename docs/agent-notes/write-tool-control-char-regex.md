---
trigger: regex control character class, control-char escape, redact control characters, strip control characters, backslash-x-zero-zero, backslash-u-zero-zero-zero-zero, stray space becomes NUL, space near closing brace becomes null byte, sourceHygiene contains byte 0x00
depends_on: none (agent tool-call transport behavior, not a repo dependency)
recorded: 2026-09-04
---

# A Write/Edit tool call can silently turn ordinary characters into raw control bytes

**Symptom:** A TypeScript/JavaScript source file written via the Write tool
(or edited via Edit) ends up with an actual raw control byte (most often
0x00 NUL) on disk at a position where the call's own text held an ordinary
printable character. `file <path>` reports it as `data` instead of
`ASCII text` / `... UTF-8 text`, and `grep` on it silently returns no
matches (no error) instead of finding patterns that are clearly present
when the file is opened another way -- that silent no-match is often the
first symptom noticed, well before anyone thinks to check the file type. In
this repo, `src/sourceHygiene.test.ts` catches it directly and fails with
`"<path>:<line> contains byte 0x00"`, which is the fastest and most
reliable tripwire if you're not sure whether this has happened.

Two distinct triggers have been observed so far -- the known-trigger list
below is **not** exhaustive; treat any post-Edit/Write byte-level
corruption as this same hazard even if it doesn't match either pattern.

**Trigger 1 (confirmed root cause): a literal backslash-hex control-character
escape in the call content.** A regex character class spanning control
characters -- written in the call as literal backslash-escape text, e.g. the
six-character sequence backslash, u, 0, 0, 0, 0 (a Unicode escape), or the
four-character sequence backslash, x, 0, 0 (a hex escape) -- can round-trip
through the tool-call transport as an actual raw control byte, not as the
literal backslash-escape source text. This has bitten more than once in
this project: `add-agentic-review-harness`'s own task briefs for later
clusters explicitly warn that a previous pass shipped a raw NUL and it made
git treat the file as binary, and it recurred twice more while recording
this very note: once in a `shortEcho` helper (a control-character strip in
`src/domain/harnessProtocol.ts`), and once again while writing an earlier
draft of this note file itself, in the two spots that named the offending
escape sequences literally.

**Trigger 2 (observed, minimal repro not yet isolated): a plain space
character in a short string/template literal, with no escape sequence
involved at all.** During task 15.7 of `add-agentic-review-harness`
(runtime cutover, `src/app/harnessAttempt.ts`), two separate Edit calls each
turned one ordinary space character into a raw NUL, with nothing
backslash-escaped anywhere in the call:

1. `` registeredAttachmentSources.set(`${entry.memberId} ${entry.attachment.id}`, { ``
   -- the space between the two `${...}` interpolations landed as NUL.
   `od -c` on the written line showed `... b e r I d } \0 $ { e n t r y ...`
   where the call content held `... b e r I d }   $ { e n t r y ...`
   (an ordinary space, not an escape sequence).
2. Immediately after fixing (1) with a binary-safe Python replace, a brand
   new helper added by a separate Edit call —
   `return [memberId, attachmentId].join(' ');` — corrupted the single space
   inside `.join(' ')` the same way: `od -c` showed
   `... j o i n ( ' \0 ' ) ; ...` in place of `... j o i n ( '   ' ) ; ...`.

Both spaces sat immediately next to punctuation (`}` / `'`) in a short
string/template literal, but that has not been confirmed as the actual
trigger condition -- it may instead be positional, content-adjacent, or
nondeterministic. Both were caught immediately by
`src/sourceHygiene.test.ts` and fixed the same way as trigger 1 (see below).
A third, differently-shaped edit in the same session (writing the replacement
via a Python binary-mode script from the start, rather than another Edit
call) produced no corruption -- consistent with, but not proof of, this
being an Edit/Write-tool-specific transport issue rather than something
about the specific characters chosen.

**Fix for trigger 1 (escape sequences):** Avoid writing the escape sequence
as literal tool-call text at all, in source code or in prose describing the
bug. Filter by numeric code point instead of a regex character class over
control characters:

```ts
Array.from(text)
  .filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  })
  .join('');
```

Note that `0x20` and `0x7f` above are plain hexadecimal *number literals*,
not string escape sequences -- they are safe to write. What is unsafe is a
backslash immediately followed by `x` or `u` and hex digits, inside any
string or regex literal in the tool-call content.

If a regex control-char class is genuinely required in shipped code, build
it from computed values (`String.fromCharCode(...)`, a dynamically
constructed `RegExp`) rather than a literal escape sequence in the file
content passed to Write/Edit. If you must describe the escape sequence in
prose (as this note does), spell it out character-by-character instead of
typing the literal sequence, exactly as done above.

**Fix/mitigation for trigger 2 (plain-space corruption, no known reliable
avoidance):** No safe way to *prevent* this by wording the call differently
has been identified yet -- the corrupted spaces were ordinary characters
with nothing to substitute them for. Instead:

- After any Edit/Write whose new content includes a short string or
  template literal with a bare space adjacent to punctuation (`}`, `'`,
  `"`, or similar), immediately re-check that exact region rather than
  trusting the tool succeeded as specified -- don't wait for the test suite.
- If corruption is found, do not retry the same Edit call expecting a
  different result; fix it out-of-band with a binary-safe Python
  read/replace/write (see the detection-and-fix recipe below) and verify
  with a byte count.
- If you are about to make several similar edits in the same session (e.g.
  a small helper plus its call site) and one has already been observed
  corrupted, switch that whole batch of edits to a Python
  read-modify-write script rather than continuing with more Edit calls on
  the same file -- that fully avoided a third occurrence in the session
  that surfaced this trigger.

**Detection and fix recipe:** after writing/editing a source file, if there
is any reason to suspect this (an escape sequence or a bare space near
punctuation was involved, `src/sourceHygiene.test.ts` failed with a
`contains byte 0x00` message, or a prior grep against the file returned
nothing when it plainly should not have):

```bash
file path/to/file.ts   # anything other than "... ASCII text" / "... UTF-8 text" is the tripwire
python3 -c "
data = open('path/to/file.ts','rb').read()
bad = [(i, b) for i, b in enumerate(data) if b < 0x20 and b not in (0x09, 0x0A, 0x0D)]
print('count', len(bad)); print(bad[:10])
"
```

Once the corrupted byte(s) are located, fix with a binary-safe read/replace
(never another Edit/Write call on the same content -- it can reproduce the
same corruption), then re-verify the count is zero:

```python
path = "path/to/file.ts"
with open(path, "rb") as f:
    data = f.read()
old = b"...bytes with the actual raw control byte, copied from the bad tuple above or from `od -c`..."
new = b"...the intended bytes, e.g. an ordinary space or the literal escape text..."
assert data.count(old) == 1
data = data.replace(old, new)
assert b"\x00" not in data  # or whichever byte was found
with open(path, "wb") as f:
    f.write(data)
```

**Why it was not obvious:** `tsc` and `eslint` still pass on a file with an
embedded raw control byte in the middle of a string/template/regex literal
-- neither one flags it. `vitest` as a whole does too, *unless* the project
has a dedicated byte-scanning test like this repo's
`src/sourceHygiene.test.ts`; without one, nothing in the normal verify loop
catches it. Only `file` (or a byte-level scan) reliably surfaces it; `grep`
without `-a` degrades silently instead of erroring, which reads as "no
matches" rather than "this file is corrupt."

**Stronger enforcement worth considering:** this is a good candidate for a
pre-commit hook or CI check (a byte scan over staged text files, refusing
any control byte outside tab/LF/CR) rather than relying on this note being
read -- that was out of scope for the pass that recorded this note.

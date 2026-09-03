---
trigger: regex control character class, control-char escape, redact control characters, strip control characters, backslash-x-zero-zero, backslash-u-zero-zero-zero-zero
depends_on: none (agent tool-call transport behavior, not a repo dependency)
recorded: 2026-09-04
---

# Do not write a literal backslash-hex control-character escape as Write/Edit tool-call content

**Symptom:** A TypeScript/JavaScript source file written via the Write tool
(or edited via Edit) that contains a regex character class spanning control
characters -- written in the call as literal backslash-escape text, e.g. the
six-character sequence backslash, u, 0, 0, 0, 0 (a Unicode escape), or the
four-character sequence backslash, x, 0, 0 (a hex escape) -- can round-trip
through the tool-call transport as an actual raw control byte on disk, not
as the literal backslash-escape source text. The file then contains a real
0x00 (NUL) or other byte below 0x20 at that position. `file <path>` reports
it as `data` instead of `ASCII text` / `... UTF-8 text`, and `grep` on it
silently returns no matches (no error) instead of finding patterns that are
clearly present when the file is opened another way -- that silent
no-match is often the first symptom noticed, well before anyone thinks to
check the file type.

This has bitten more than once in this project: `add-agentic-review-harness`'s
own task briefs for later clusters explicitly warn that a previous pass
shipped a raw NUL and it made git treat the file as binary, and it recurred
twice more while recording this very note: once in a `shortEcho` helper (a
control-character strip in `src/domain/harnessProtocol.ts`), and once again
while writing an earlier draft of this note file itself, in the two spots
that named the offending escape sequences literally.

**Fix:** Avoid writing the escape sequence as literal tool-call text at all,
in source code or in prose describing the bug. Filter by numeric code point
instead of a regex character class over control characters:

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

**Detection recipe:** after writing/editing a source file, if there is any
reason to suspect this (a control-character escape was involved, or a prior
grep against the file returned nothing when it plainly should not have):

```bash
file path/to/file.ts   # anything other than "... ASCII text" / "... UTF-8 text" is the tripwire
python3 -c "
data = open('path/to/file.ts','rb').read()
bad = [(i, b) for i, b in enumerate(data) if b < 0x20 and b not in (0x09, 0x0A, 0x0D)]
print('count', len(bad)); print(bad[:10])
"
```

**Why it was not obvious:** `tsc`, `eslint`, and `vitest` all still pass on a
file with an embedded raw control byte in the middle of a string/regex
literal -- nothing in the normal verify loop catches it. Only `file` (or a
byte-level scan) surfaces it; `grep` without `-a` degrades silently instead
of erroring, which reads as "no matches" rather than "this file is corrupt."

**Stronger enforcement worth considering:** this is a good candidate for a
pre-commit hook or CI check (a byte scan over staged text files, refusing
any control byte outside tab/LF/CR) rather than relying on this note being
read -- that was out of scope for the pass that recorded this note.

---
trigger: openspec validate
depends_on: package.json, openspec/config.yaml
recorded: 2026-09-06
---

# `openspec validate` takes the change name positionally, not `--change`

**Symptom:** `openspec validate --change "<name>" --strict` exits non-zero with

```
error: unknown option '--change'
(Did you mean --changes?)
```

`--changes` is a different flag (it selects *all* changes), so following the
suggestion validates the wrong thing rather than failing again.

**Fix:** pass the name as a positional argument.

```sh
openspec validate "<change-name>" --strict
```

**Why it was not obvious:** every neighbouring command in the same workflow
takes `--change`, including the two you run immediately before and after it:

```sh
openspec status       --change "<name>" --json
openspec instructions apply --change "<name>" --json
openspec validate     "<name>" --strict          # <- the odd one out
```

Reaching for `--change` here is the natural move, and the error message steers
you toward a flag that silently does something else.

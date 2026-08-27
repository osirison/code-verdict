---
trigger: git push, git pull, git fetch, gh repo create
depends_on: .git/config, ~/.gitconfig, ~/.ssh/config
recorded: 2026-08-27
---

# `git push` when SSH is unreachable, or the remote is HTTPS

`origin` on this repository is SSH (`git@github.com:osirison/code-verdict.git`).
Two separate situations make that fail, and both are fixed the same way.

## Symptom 1: SSH is blocked or timing out

`git push` hangs with no output until whatever timeout is wrapping it. Confirm
before assuming it is a credentials problem:

```bash
GIT_SSH_COMMAND="ssh -o ConnectTimeout=10 -o BatchMode=yes" git push
# ssh: connect to host github.com port 22: Connection timed out

curl -s -o /dev/null -w "%{http_code}\n" https://github.com   # 200 — HTTPS is fine
```

Observed 2026-08-27: **both** port 22 and the usual fallback `ssh.github.com:443`
timed out while HTTPS was working, so trying the 443 fallback is not enough.

## Symptom 2: the remote is HTTPS and there is no credential helper

There is no global `credential.helper`, so git falls back to `core.askPass`,
which on this machine is `/usr/bin/ksshaskpass` — a GUI prompt. A non-interactive
shell cannot answer it:

```text
error: unable to read askpass response from '/usr/bin/ksshaskpass'
fatal: could not read Username for 'https://github.com': No such device or address
```

`gh repo create` sets an HTTPS remote by default, so scratch repositories land here.

## Fix

Push through the `gh` credential helper. `gh` is already authenticated
(`gh auth status` → *Git operations protocol: https*); only git does not know it.

```bash
# HTTPS remote already configured:
git -c credential.helper='!gh auth git-credential' push origin <branch>

# SSH remote, but SSH is unreachable — give the HTTPS URL explicitly:
git -c credential.helper='!gh auth git-credential' \
  push https://github.com/osirison/code-verdict.git HEAD:<branch>
```

`-c` applies to the one command, so this leaves the user's global git config
untouched. `gh auth setup-git` would set the helper permanently — that is a
change to their machine, so ask first.

## Why it is not obvious

The two symptoms look nothing alike from the command line — one hangs silently,
the other fails on a credential prompt — but the same helper resolves both,
because in each case the only working transport is HTTPS and git has no way to
authenticate over it.

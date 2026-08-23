# `git push` over an HTTPS remote

`origin` on this repository is SSH (`git@github.com:osirison/code-verdict.git`), so
ordinary pushes need no credential helper.

A repository added with an **HTTPS** remote does. There is no global
`credential.helper` configured, so git falls back to `core.askPass`, which on this
machine is `/usr/bin/ksshaskpass` — a GUI prompt. In a non-interactive shell it
cannot read a response and the push fails:

```
error: unable to read askpass response from '/usr/bin/ksshaskpass'
fatal: could not read Username for 'https://github.com': No such device or address
```

Push through the `gh` credential helper instead:

```bash
git -c credential.helper='!gh auth git-credential' push origin <branch>
```

Or set an SSH remote in the first place. This matters when creating a scratch
repository with `gh repo create`, which sets an HTTPS remote by default.

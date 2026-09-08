---
trigger: npm run build, npm run watch, node scripts/copy-codicons.mjs
depends_on: scripts/copy-codicons.mjs, package.json
recorded: 2026-09-06
---

# `npm run build` in a git worktree needs its own `npm install` first

**Symptom:** in a worktree under `.worktrees/`, `npm run build` dies before
esbuild ever runs:

```
Error: ENOENT: no such file or directory, copyfile
  '<worktree>/node_modules/@vscode/codicons/dist/codicon.css'
  -> '<worktree>/media/codicons/codicon.css'
```

This reads like a missing or broken dependency. It is neither —
`@vscode/codicons` is a normal declared dependency and CI (`npm ci` on a fresh
checkout) builds fine.

**Fix:** run `npm install` in the worktree once.

**Why it was not obvious:** every *other* tool works in a fresh worktree with no
install at all. `npx vitest run`, `npm run typecheck` and `npm run lint` all
succeed, because Node's resolution walks up the directory tree and finds the
parent clone's `node_modules`. `scripts/copy-codicons.mjs` is the only thing that
does not: it joins the path by hand from the repo root.

```js
const from = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
```

So the whole toolchain appears healthy right up until the build step, which is
the misleading part.

**If you only need the bundle** — to check that a change compiles, or to load it
headlessly as in `f5-extension-development-host.md` — skip the copy step and run
esbuild directly. Codicons are webview chrome; the bundle does not need them:

```sh
npx esbuild src/extension.ts --bundle --outfile=dist/extension.js \
  --external:vscode --format=cjs --platform=node --target=node20 --sourcemap
```

**Worth fixing at some point:** resolving the package the way Node does would
make the script work in a worktree with no install, and cost one line.

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const from = join(dirname(require.resolve('@vscode/codicons/package.json')), 'dist');
```

Verified to resolve to the parent clone from inside a worktree.

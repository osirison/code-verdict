---
trigger: npm update jsdom, npm install jsdom, npm outdated, dependabot jsdom bump, @types/jsdom
depends_on: .github/workflows/ci.yml, package.json
recorded: 2026-09-25
---

# jsdom cannot go past 29 while CI tests Node 20

**Precondition:** before bumping `jsdom`, read the `test` job's matrix in
`.github/workflows/ci.yml`. The lowest Node version in that matrix is a hard
ceiling on the jsdom major.

As recorded, the matrix is `[20, 22]` and jsdom is pinned to `^29.1.1`. The two
are coupled:

| package | `engines.node` |
|---|---|
| jsdom 29 | `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0` |
| jsdom 30 | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |

jsdom 30 excludes Node 20 outright. Confirm the current values rather than
trusting this table:

```sh
npm view jsdom@30 engines
npm view jsdom engines
```

**Why Node 20 is in the matrix at all:** it is the extension host runtime for
the `vscode ^1.96` baseline this extension declares in `engines.vscode`. Dropping
the Node 20 leg to unblock a jsdom bump would silently stop testing the runtime
most users are actually on. The jsdom pin is the cheaper side of that trade.

**`@types/jsdom` does not track jsdom's majors.** There is no `@types/jsdom` 29
at all — published versions jump from 28 straight to 30, which is why the pin
reads `^28.0.3` against jsdom 29 and is correct rather than stale. Check before
assuming a matching major exists:

```sh
npm view @types/jsdom versions
```

**Not observed:** what the failure actually looks like on Node 20 with jsdom 30.
`engine-strict` is not set and there is no `engines.node` in `package.json`, so
`npm ci` warns (`EBADENGINE`) rather than failing, and the break would surface
somewhere in the test run instead of at install. If you hit it, record the real
symptom here.

**Worth fixing at some point:** declaring `engines.node` in `package.json` and
setting `engine-strict=true` in an `.npmrc` would turn this from a note into an
install-time error that names jsdom. Untested here — it also makes every other
dependency's `engines` mismatch fatal, so it needs a run on both matrix legs
before it goes in.

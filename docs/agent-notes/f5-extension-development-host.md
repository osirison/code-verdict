# F5: when the Extension Development Host window dies instantly

Symptom: pressing F5 opens the Extension Development Host, and it disappears within a second.
The main VS Code window survives. It reads as "VS Code crashed".

## Tell the two failure shapes apart before doing anything else

The extension host writes a log per window under
`~/.config/Code/logs/<session>/window<N>/exthost/exthost.log`. Windows are numbered in creation
order, so the newest directory is the F5 attempt. Two lines decide it:

| Last line | Meaning |
| --- | --- |
| `terminating: received terminate message from renderer` | Normal. You stopped debugging. |
| `terminating: renderer closed the MessagePort` | The window died under the extension host. |

A healthy development host log is 70–170 lines and contains
`_doActivateExtension osirison.code-verdict`. A dead one is **three lines** — started,
terminating, exiting with code 0 — and never names the extension. Three lines means the extension
never ran, so nothing in `src/` can be the cause, however tempting the timing is.

In the renderer log for the same window, the giveaway is `Canceled` inside
`_onExtensionHostExit → _doStopExtensionHosts`. In a development window that handler closes the
window, so the extension host went away first and VS Code shut the window behind it.

## Red herrings, each confirmed harmless

- `Unable to create workbench contribution 'chat.contextContributions'. [createInstance] _St
  depends on UNKNOWN service chatSessionRoutingProviderService.` — appears in **every** window,
  including ones where the development host runs fine for minutes. Not the cause.
- `osirison.code-verdict created a webview without a content security policy` — `renderPage`
  emits the CSP meta unconditionally, `embedded` included. The warning fires against the webview's
  initial empty html, before the first assignment.
- File-watcher `ENOENT` bursts pointing at paths under `/tmp/claude-1000/...` — a scratch git
  worktree being removed while VS Code watched it. Transient and unrelated.

## The bisect, in the order that costs least

Each step is one command and none of them touch the real profile except the last.

```sh
PROBE=/tmp/verdict-probe && rm -rf "$PROBE" && mkdir -p "$PROBE/data" "$PROBE/ext"

# 1. Clean profile, no other extensions. Isolates the extension itself.
code --extensionDevelopmentPath="$PWD" \
     --user-data-dir="$PROBE/data" --extensions-dir="$PROBE/ext" --new-window

# 2. Clean profile, your real extensions. Isolates an extension interaction.
code --extensionDevelopmentPath="$PWD" \
     --user-data-dir="$PROBE/data" --extensions-dir="$HOME/.vscode/extensions" --new-window

# 3. Your real instance, no debugger. This is F5 minus the debug attach.
code --extensionDevelopmentPath="$PWD" --new-window
```

Step 3 is the one that matters. It opens a window **inside the already-running instance**, exactly
as F5 does, and differs from F5 in one respect only: `isExtensionDevelopmentDebug` is false. If
step 3 activates the extension and step F5 does not, the fault is in the debug attach, not in the
extension, the extension set, or the profile.

Confirm what each probe did by grepping its own log — for steps 1 and 2,
`"$PROBE"/data/logs/*/window1/exthost/exthost.log`; for step 3, the newest `window<N>` under the
real session directory.

## Verifying the bundle without a window at all

`dist/extension.js` can be loaded head­lessly against a stubbed `vscode` module to prove
`activate()` neither throws nor spins. Requiring the bundle with `Module._load` patched to return a
permissive Proxy for `require('vscode')`, then calling `activate(context)` with
`extensionMode: 2`, exercises the same debug-bypass branch F5 takes. A healthy run resolves in tens
of milliseconds; as of the background-review-runs change it registers 29 commands, 36 subscriptions
and 6 status-bar items. This separates "the extension is broken" from "the window is dying" in
seconds, without a display.

Treat those counts as a floor that grows, not a fixture: what matters is that `activate()` resolves
rather than throwing or hanging, and that a command you have just added appears in the list. The
stub needs `Memento.keys()` since retention reads it, and `lm.selectChatModels` returning `[]` is
enough — nothing on the activation path awaits a model.

## Two shell traps hit while doing this

- **`pkill -f <pattern>` matches the invoking shell.** `pkill -f "scratchpad/probe/data"` killed
  its own command line and silently aborted the rest of the compound command. Collect PIDs with
  `pgrep -f`, skip `$$`, and `kill` them individually.
- **A bare `until` busy-wait with no `sleep` pins a core** and outlives the thing it is waiting
  for. Wrap it: `timeout 60 bash -c 'until [ -e <path> ]; do sleep 2; done'`.

## What is genuinely not the cause

Checked with evidence rather than assumed, on Fedora 44 / KDE / VS Code 1.134.0:

- **VS Code version skew** — an update landing under a long-running process. Compare
  `stat -c %y /usr/share/code/code` and `rpm -q code --last` against `ps -o lstart= -p <code pid>`.
- **OOM** — `~/.config/Code/Crashpad/reports` empty, and no `oom-kill` in `journalctl`. Note the
  main log's `crashed with code 15 and reason 'killed'` is SIGTERM, i.e. a deliberate stop; the OOM
  killer uses SIGKILL.
- **inotify exhaustion** — compare `find /proc/*/fd -lname anon_inode:inotify | wc -l` against
  `/proc/sys/fs/inotify/max_user_instances`.
- **The preLaunchTask** — `npm run build` succeeding, and for `build-and-emulator`, the emulator
  printing the exact `endsPattern` line `GitLab emulator listening on`. If a stale emulator holds
  `:8971`, node exits `EADDRINUSE`, that line never prints, and the launch waits forever — a hang,
  not a crash.
- **A stale inspect port or orphaned host** — `ps -eo pid,cmd | grep inspect-brk-extensions`.

# Debugging a harness review run

## The output-channel logs lag the run

The extension development host writes `logs/Code Verdict: Agent Trace.log` and
`logs/Verdict: API.log` into the worktree root. **These files flush late** — a
run still dispatching tools was observed with its trace file untouched for two
and a half minutes. Do not conclude a run has hung from the log's modification
time alone.

## Read the run's own checkpoint instead

Every attempt persists checkpoints to VS Code global storage, and they carry far
more than the log: phase, elapsed time, budget counters, per-file coverage state,
and every tool call with its target and failure reason.

    cp ~/.config/Code/User/globalStorage/state.vscdb /tmp/s.vscdb
    sqlite3 /tmp/s.vscdb "select value from ItemTable where key='osirison.code-verdict';" > /tmp/verdict.json

Keys are `codeVerdict.harness.lineage.<lineageId>`. Pick the one whose newest
timestamp is latest and whose blob mentions the change request number, then read
`checkpoints[-1]`: `coverage`, `budget`, `candidates`, and the `activity` array.
Counting `toolCompleted` by `(tool, target)` and printing every `toolFailed`
reason is usually the whole diagnosis.

`terminalAttempts` is empty while a run is still live.

## Full prompts and replies

Off by default. Set `codeVerdict.trace.rawPayloads` to true in user settings,
alongside `codeVerdict.trace.api`. Raw content reaches the "Code Verdict: Agent
Trace" output channel only — never the checkpoint, the diagnostics report,
storage, or the `agent-trace.log` file the extension writes beside that channel.
Turn it on *before* the run you need to inspect.

Read it in the Output panel, not in `agent-trace.log`: the file deliberately
carries only the metadata lines and one note per request saying the raw payload
went to the channel instead. Until 2026-09-11 the file did carry raw payloads —
one log was found with 113 full prompts and 111 full replies in it, 20 MB — while
every one of those lines said "never persisted". VS Code's own capture of the
channel still writes what the channel shows into VS Code's log directory, which
is outside the extension's control, so "live-only" means "not written by Code
Verdict", not "never touches a disk".

## Check what the run was configured with before anything else

Every attempt writes one block into the agent trace before its first model
call, naming each `codeVerdict.harness.*` value it resolved and where that
value came from:

    grep 'resolved configuration' 'logs/Code Verdict: Agent Trace.log'
    grep '] policy ' 'logs/Code Verdict: Agent Trace.log'

Three forms, and the difference between the first two is the point:

    [run-x#1] policy maxPromptKilobytesPerTurn=192 (shipped default)
    [run-x#1] policy maxPromptKilobytesPerTurn=96 (settings.json)
    [run-x#1] policy maxModelTurnsPerAttempt=64 — REJECTED: settings.json supplied -5, not used; the attempt runs on 64

`(shipped default)` on a setting you edited means the edit is not reaching the
run — a different settings scope, a typo in the key, or a stale window.
`REJECTED` means the value was read and discarded by normalization, which is
the case that was previously invisible: `normalizeHarnessPolicy` replaces an
unusable value with the default silently.

Only the settable surface is in the block. Provider page sizes, the backoff
curve and `globalConcurrency` are not reviewer-settable and are deliberately
absent.

The same block carries the attempt's other resolved facts on the lines above
the policy ones — the model and vendor that will answer, the investigation
source actually selected per member, and the base/head the member is pinned
to. Grep the run tag (`[run-x#1]`) to read all of it together; two concurrent
attempts interleave in one file, which is why every line carries that tag.

## The trace no longer has a line per streamed token

`AgentTrace.fragment` writes at most two kinds of line per request: the first
fragment (its `+Nms` is the time to first token) and any fragment that arrived
more than 10s after the one before it (`— stall: <gap>ms since fragment #N`).
A healthy request is five lines end to end (six if it stalled), and a stream of
700 fragments looks identical to one of 3 until you read the closing `done in
Xms across N fragment(s)` line — that count is still every fragment. A run that
failed never gets that line, so its `failed after ...` line carries the same
counts instead.

So an empty-looking request is not evidence of an empty stream. Before this
change a per-token line made 37% of the file; grepping `fragment #` now finds
one line per request, not thousands.

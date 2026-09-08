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

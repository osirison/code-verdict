# Handoff: Code Verdict — GitLab AI review extension for VS Code

## Overview

Code Verdict is a VS Code extension that turns an AI code review into a human decision. A developer
points a GitHub Copilot review agent at a GitLab merge request; the agent's findings arrive as
reviewable items carrying severity, category and confidence; the developer triages each one as
**Accepted / Rejected / Skipped**, deep-diving with the agent where it matters; then the extension
composes the review and posts it to GitLab — inline comments with applyable suggestions for what was
accepted, a summary comment in the developer's words, and nothing at all for what was thrown out.

Around that core it provides **pods** (named sets of GitLab projects watched together) with a
cross-project dashboard of merge requests, issues and pipelines; a posted-review tracker for author
replies; an agent scorecard that turns accept/reject history into criteria changes; notifications;
and settings.

Marketplace name: **Code Verdict**. In-product name: **Verdict**. Command prefix: `Verdict:`.
Settings namespace: `codeVerdict.*`.

## About the design files

The files in `prototypes/` are **design references written in HTML** — they demonstrate intended
look, copy and behaviour. They are not production code and should not be ported line-for-line. They
are single-file components that paint from inline styles; there is no build step, no component
library, and no state management worth carrying over.

The task is to **recreate these designs as a real VS Code extension** using that platform's
conventions: a TypeScript extension host, a `TreeDataProvider` (or webview) for the sidebar,
webview panels for the editor-tab screens, `DecorationProvider` + peek widgets for in-diff review,
`StatusBarItem`, `SecretStorage` for the token, and the `vscode.lm` / chat-participant APIs to reach
Copilot agents. Inside the webviews, use whatever framework the team already uses (React is the
common choice for VS Code webviews); if nothing exists yet, pick one and stay consistent.

Two platform rules the prototype fakes and the real thing must honour:

- Colors must come from **VS Code theme variables** (`--vscode-editor-background`,
  `--vscode-sideBar-background`, `--vscode-charts-red`, …), not the hex values below. The hexes in
  this document are the Dark+ resolutions — use them to verify your theme mapping, not as literals.
  The prototype's own theme switcher (Dark+ / Deep space / Light+) exists only to prove the design
  survives a theme change.
- The window chrome in the prototype (title bar, activity bar, tabs, status bar) is **mock**. The
  real extension renders only its own regions.

## Fidelity

**High-fidelity.** Layout, spacing, type scale, copy and interaction states are final and
intentional. Recreate them precisely, mapping color to theme tokens as described above. The copy is
part of the design — it is written in a specific voice (terse, senior-reviewer) and should ship as
written unless product wants a change.

The one exception is `prototypes/GitLab AI Review - Explorations.dc.html`, which is a record of
eight explored directions. It is context, not a spec — do not build from it.

---

## Screens / Views

Every screen is 1440×920 in the prototype. The sidebar is 308px; the activity bar 48px; the tab strip
36px; the status bar 26px.

### 1. Onboarding (`screen: 'onboard'`)

**Purpose:** first-run setup — connect GitLab, create the first pod, add projects.

**Layout:** editor-tab webview, content capped at 820px, 26px/30px padding, 24px gap between
sections. A step rail at the top (three pills), the active step's body below, and a footer with
Continue / Back separated by a 1px top border and 18px padding.

**Step rail:** each pill is a 20px circle (number, or ✓ when complete) plus a 12px/500 label, in a
16px-radius container with `--bg3` background when active. Complete circles are `--ok-strong`
(#238636); active is `--accent` (#0078d4); pending is a 1px `--line2` border with `--fg-dimmer` text.
Clicking a *previous* step returns to it; future steps are not clickable.

**Step 1 — Connect.** Heading "Welcome to Code Verdict" (19px/600), body copy 12.5px/1.6 at
`--fg-dim` explaining the token goes to the VS Code secret store and never to settings.json. Two
inputs side by side in a 2-column grid, 14px gap, max 600px: Instance URL (text, JetBrains Mono
12.5px) and Access token (password). Inputs: 1px `--line2` border, 5px radius, `--bg2` background,
9px/11px padding, no outline. Below, a "Test connection" button (`--line` background, 1px `--line2`
border) and a status line that reads "Not tested yet" in `--fg-dimmer` and, once tested,
"✓ Connected as @you · api scope · token expires in 42 days" in `--ok`.

**Step 2 — Pod.** Heading "Name your pod" plus a sentence defining what a pod is. One text input
(max 400px, 13px/500) and three suggestion chips (Platform squad / Payments / My work) — 6px/11px
padding, 14px radius, 1px `--line2` border, hover border `--accent`.

**Step 3 — Projects.** Heading "Add projects to <pod name>". One 12.5px JetBrains Mono input (flex:1,
max 640px total with the Add button) whose placeholder shows all three accepted shapes:
`https://gitlab.com/hve/platform/core · 9102 · group 4821`. Add button is `--accent` when the input
resolves and `--line`/`--fg-dimmer` when it doesn't. Under the input, a live detection line in 11px
JetBrains Mono:

- empty → "Accepts a full URL, a numeric project id, or “group &lt;id&gt;”."
- group → "detected group 4821 · hve/platform · 5 projects"
- project → "detected project 9102 · hve/platform/auth-service"
- unknown numeric → "detected project id 7777 · not visible with this token"
- unresolvable → "no match — check the id or paste the full URL"

Three dashed sample chips (project URL / project id / group id) fill the input on click.

Each added source renders as a card: 1px `--line` border, 6px radius, header row with `--bg2`
background, a 9.5px uppercase kind badge (`--agent` on `--agent-t` for group, `--accent` on
`--sel-soft` for project), the path in 12.5px/500 JetBrains Mono, meta ("group 4821" / "id 9102" /
"unresolved"), and a ✕ remove. A **group** card expands into a project chooser: an "All projects"
toggle row plus one row per project — 8px/13px padding with 26px left indent, checkbox glyph
(☑ `--accent` / ☐ `--fg-dimmer`), path in 12px JetBrains Mono, `id 9101`, and an open-MR count
(`--fg-dim` when nonzero, `--fg-dimmer` when "no open MRs"). Selected rows get a `--sel-soft`
background.

Footer: "Create pod · 5 projects" in `--brand` (#fc6d26) when valid, and a hint that counts what the
pod will watch across how many sources.

**Sidebar during onboarding:** a "Setup" checklist mirroring the three steps with ○/✓ marks and live
meta (instance host, pod name, "5 selected"), plus a "Skip and use a demo pod" link at the bottom.
The Posted-reviews / Agent-tuning / Settings nav rows are hidden until setup completes.

### 2. Pod dashboard (`screen: 'dashboard'`)

**Purpose:** answer "whose turn is it?" across every project in the pod.

**Layout:** header row (14px/20px padding, 1px bottom border), a 4-column stat strip (1px gaps
showing `--line` as grid lines), then a 2.4fr / 1fr split — MRs and issues on the left, activity and
pipelines on the right.

**Header:** pod name (14px/600) + meta ("5 projects · 9 open MRs") + a ▼ caret, all clickable to open
the pod switcher — an absolutely positioned 260px-min dropdown (`--bg3`, 1px `--line2`, 6px radius,
`0 10px 28px rgba(0,0,0,.5)` shadow) listing pods with a ✓ on the active one and a "+ New pod…"
footer row. Then scope pills in a `--bg3` 5px-radius container: **All**, **Waiting on you · 3**,
**Waiting on them · 6** — active pill `--accent` with white text. Right side: "⟳ 2m ago" and
"Filters" in 11px JetBrains Mono with 1px `--line2` borders.

**Stat cards:** label 11px `--fg-dim`, value 27px/600 JetBrains Mono, note 11px. In order:
Waiting on you (value `--fg-hi`, note `--sev-major`), AI review coverage (`--ok`, e.g. "7/9"),
Pipelines failing (`--sev-blocker`), Projects in pod (`--fg-hi`). **Every one of these must derive
from the same pod query** — the prototype's most repeated bug was hardcoded counts contradicting
derived ones.

**MR table:** filter chips (All projects · 9, then one per project with counts), then a
`minmax(0,1fr) 108px 104px 84px 58px` grid with 10px gaps and 20px horizontal padding. Header row is
10px/500 uppercase, letter-spacing .09em, `--fg-dimmer`. Each row: 12px vertical padding, 1px `--row`
bottom border, hover `--bg3`, cursor pointer. Title 12.5px/500 `--fg-hi` ellipsised; meta line
10.5px JetBrains Mono `--fg-dimmer` reading `!2841 · @you · feat/auth-refresh`. AI-review cell is a
pill with 5px/8px padding and 3px radius, colored by state: `8 items`/`3 items` amber
(`--sev-major` on `--sev-major-t`), `not run` grey, `clean` green, `2 blockers` red, `submitted`
purple (`--agent`). Pipeline cell is 11px/500 JetBrains Mono colored green/red/blue for
passed/failed/running. Age in `--fg-dimmer`.

Below the MRs, an "Issues · in progress" section on the same grid (title, project, assignee,
milestone, age). Right column: "Activity" — icon (✕ red / ◈ purple / ✓ green / ⚑ amber), a 12px/1.45
text line and a 10.5px JetBrains Mono meta line — then "Pipelines · last 3" as icon + id + job + age.

**Row click:** a submitted MR opens Posted reviews; anything else opens Run review. Both reset the
triage state for the newly opened MR.

**Empty pod:** no filter chips, no table header, no issues section — just "Nothing waiting on you",
a sentence naming the pod and its project count, and two buttons (Add projects to this pod / Switch
pod).

### 3. Run review (`screen: 'agent'`)

**Purpose:** choose the agent and the criteria, then run.

**Layout:** 760px max, 26px/30px padding, 22px gaps.

**Header:** a 11px JetBrains Mono subline `!2841 · hve/platform/core · feat/auth-refresh · 9 files,
+284 −91`, then "Run an AI review" (19px/600), then a sentence stating agents come from the Copilot
workspace and criteria are saved per project.

**Agent dropdown:** a collapsed row (1px `--line2`, 5px radius, `--bg2`, 9px/11px padding, hover
border `--accent`) showing a 7px `--agent` dot, the agent name in 12.5px/600, a source badge
(`copilot` / `workspace` — 9.5px JetBrains Mono, `--agent` text, 1px `--agent-b` border), and a
▼/▲ caret. Open state is an absolute dropdown with a 9.5px uppercase header "Copilot agents in this
workspace", one row per agent (✓ + name + 11px description + source badge, active row `--sel`), and a
"Manage agents in Copilot settings…" footer in `--link`. Under the control, the selected agent's
description plus a link "56% accepted in this pod →" that opens Agent tuning.

**Criteria:** a 2-column grid. Left: "Report at or above" as four equal segments
(nit / minor / major / blocker) in 11px JetBrains Mono, active `--accent`, plus a hint that changes
per selection ("Balanced: minor, major, blocker." / "Everything, nits included — noisy on large MRs."
/ "Blockers only — fastest pass, misses test gaps."). Right: "Minimum confidence · 70%" with a 4px
track, `--accent` fill and a 12px `--fg-hi` knob.

**Categories:** nine chips — Security, Concurrency, Error handling, Performance, Craftsmanship,
API contract, Tests, Docs & comments, Style. On = tinted background in the category color with a ✓
suffix; off = 1px `--line2` border, `--fg-dimmer`. Defaults on: Security, Concurrency,
Error handling, Performance, Craftsmanship, Tests. Below, a hint counting the active set and quoting
the first and last category's scope; when all are off it reads "Pick at least one category — the
agent has nothing to look for."

**Extra instructions:** a 12px/1.7 JetBrains Mono box, `--bg2`, containing free-text agent
instructions.

**Footer:** "Run review" (`--brand`), Cancel, and a hint naming the diff size.

**Sidebar in this state** shows the MR identity and agent but no triage UI — just
"No review items yet. Pick an agent and run the review."

### 4. Running (`screen: 'running'`)

420px centered column: a 14px spinner ring in `--agent` (`animation: spin .8s linear infinite`), the
agent name, a percentage, a 4px progress track with a `.5s ease` width transition, and a log of five
steps that resolve from `· current` (`--fg`) to `✓ done` (`--fg-dimmer`):

1. Resolving agent from Copilot workspace…
2. Indexing 9 changed files (+284 −91)…
3. Cross-referencing auth module history…
4. Scoring findings against project criteria…
5. 8 items ready

**Failure card** (on timeout): 1px `--sev-blocker-b` border with a 3px `--sev-blocker` left edge,
`--card` background. Title "Agent stopped · timed out after 90s"; body naming how many files were
read and what was missed; three buttons — "Use 4 partial findings" (`--accent`), "Retry",
"Switch to Fast Diff Review"; and a 10.5px JetBrains Mono line
`copilot.request.timeout · 90000ms · request id 4f19c2`.

### 5. Triage (`screen: 'triage'`)

**Purpose:** decide every finding.

**Header:** MR title, ref · project, four severity tallies as pills (2 blocker / 2 major / 3 minor /
1 nit, each tinted in its severity color), and a mode switch on the right — **Split / Queue / In
diff** in a `--bg3` container. All three modes share one state.

**Stale banner** (when the branch moved): full-width `--sev-major-t` strip with a ⚠, a 12px/600
title "2 new commits on feat/auth-refresh while you were reviewing", a 11.5px body naming who pushed
and that N findings — including one you accepted — no longer sit on the lines the agent read, and two
buttons: "Re-anchor to HEAD" (`--accent`) and "Re-run agent". Affected items show a "line moved" chip
in the list and a ⚠ in the sidebar tree.

**Split mode.** The item detail fills the tab (the item list lives in the sidebar — see below).
Detail header: severity chip (9.5px/600 uppercase JetBrains Mono, .07em tracking, 5px/7px padding,
tinted), title 15.5px/600 `--fg-max`, then a 11px JetBrains Mono meta row —
`src/auth/token.ts:63 · security · confidence 96% · HVE Core / PR Review` (agent name in `--agent`).
Body: 13px/1.65 prose capped at 70ch with `text-wrap: pretty`. Then a code card (1px `--line`, 6px
radius, `--code` background) whose header carries the location and an "Open in editor" link, and
whose body is 12px/1.75 JetBrains Mono. Then, when the agent proposed a fix, a suggestion card —
header "Suggested change · posts as a GitLab suggestion", a `--del-bg` line with `--del-fg` text and
an `--add-bg` line with `--add-fg` text. Then four preset chips (Explain the risk / Show me a fix /
Find similar in repo / Why flagged?), 6px/11px padding, 14px radius, hover border `--agent`. Asking
appends a thread entry: a 2px `--agent` left border on `--agent-f`, a 9.5px uppercase label
("agent · explain"), and the answer. Finally a freeform input row with a ▸ prompt and a ⌘↩ hint.

Action bar (13px/22px padding, `--bg2`, 1px top border): **Accept** (`--ok-strong`, hover
`--ok-strong-h`), **Reject** (`--line` with a `--sev-blocker` border and text), **Skip**
(`--line`/`--line2`) — each with its key letter at 65% opacity — then "N of 8 triaged" and
"Generate summary →", which is `--brand` only when all items are decided and `--line`/`--fg-dimmer`
otherwise.

**Queue mode.** A 720px centered card deck: a peeking card behind (`--bg3`, 16px tall, top-rounded)
and the active card in `--card` with a 1px `--line2` border, 8px radius, 20px/22px padding, and
`animation: tin .18s ease-out` on change. Card contents: severity chip, category pill, "confidence
96%", title 18px/600, location, code block, body, preset chips, thread. Below the card: a full-width
three-button row — "← Reject" (flex:1), "↓ Skip", "Accept →" (flex:1, `--ok-strong`) — then a footer
with the triage count and a "Generate summary →" link. A pip row above the card shows one 16×4px bar
per item, colored by verdict (`--ok` / `--sev-blocker` / `--fg-dimmer`), current item `--fg-hi`,
undecided `--line2`; pips are clickable.

**In-diff mode.** A file header (path, "1 of 8", ↑ prev / ↓ next), then the diff at 12.5px/1.9
JetBrains Mono with a 56px right-aligned gutter in `--gutter`. Added lines sit on `--add-bg` with
`--add-fg` text; the flagged line sits on `--del-bg` with a 2px `--sev-blocker` left border. The
review item renders as a peek widget between the diff lines: `margin: 8px 40px 8px 56px`, 1px
`--line2` border, `--card` background, 6px radius, with a header whose left border is 3px in the
item's severity color. Header: severity chip, title, "96% · 3 of 8". Body: prose, the suggestion
card, thread, then the action row — **Accept & apply** (`--ok-strong`, label falls back to "Accept"
when there is no suggestion), "Accept, comment only", "Reject", "Skip", and an "Ask agent ⌘↩" link.

**Sidebar during triage:** MR identity, agent, a 4px verdict bar segmented green/red/grey, a count
row (`4 acc · 2 rej · 1 skip · 5 left`), filter pills (All 8 / Open 5 / Security 3), then the item
tree grouped by file — file rows show ▾ + path + count; item rows are indented 28px with a 7px
severity dot, the title (struck through and `--fg-dimmer` once accepted or rejected), and either the
confidence or a ✓/✕/⤼ verdict glyph. The active item has a 2px `--accent` left border and `--sel`
background. Footer: "Open review tab".

### 6. Clean bill (`screen: 'clean'`)

660px column, 40px top padding. A 44px `--ok-strong-t` circle with a ✓, heading "No findings above
your criteria", and a body naming how many files were read, how many candidate observations were
scored, and which floor/confidence they failed. Then a "Filtered out" card listing the buckets
("4 nits below the severity floor" / "19 observations below 70% confidence") with a 11px JetBrains
Mono explanation each. Three buttons: "Approve merge request" (`--ok-strong`), "Lower the bar and
re-run" (returns to Run review with the floor and confidence relaxed), "Back to dashboard".

### 7. Summary (`screen: 'summary'`)

840px column. Heading "Submit review to GitLab" plus the triage count. Three verdict tallies as
flex:1 blocks — accepted (`--ok-strong` filled), rejected (`--line` + `--sev-blocker` border),
skipped (`--line` + `--line2`).

**Summary comment card:** header "Summary comment · editable" with a "Regenerate" link; body is
generated text at 12.5px/1.7. Composition: `Reviewed with <agent>.` then, when blockers were
accepted, "N blockers: <title> (<file>:<line>); …. Needs a fix before merge." then "N smaller items
posted inline." then "N findings dismissed as false positives." Voice varies with
`codeVerdict.agentVoice` (terse / explanatory / blunt one-liners).

**Line comments to post (N):** one row per accepted item — ☑, location in 10.5px JetBrains Mono
(148px column), title ellipsised, and a `+suggestion` marker in `--agent` when a fix will be
attached. When nothing is accepted, a dashed empty state explains that accepted items become inline
comments here.

**Rejected findings · rationale stays local:** hidden when empty; otherwise one dimmed row per
rejected item ending in "false positive".

**Final instructions:** a box whose empty state reads "Anything the author should know before they
read the comments — merge conditions, follow-up issues, what you deliberately did not review." Three
preset chips (Merge conditions / Scope note / Thanks + push back) fill it; a "clear" link empties it.
This text is appended to the summary comment.

**Options row:** ☑ Post as single review thread · ☑ Request changes (both toggle).

**Actions:** "Submit to GitLab" (`--brand`), "Copy as markdown", "Back to triage", and a
"posts as @you" note.

**Submit failure banner:** appears above the actions — 1px `--sev-blocker-b` with a 3px left edge,
"GitLab rejected the request · 401 Unauthorized", a body that counts what is preserved ("the summary,
the 8 line comments and your final note are still here"), and two buttons: "Reconnect GitLab" (jumps
to onboarding step 1) and "Retry submit".

### 8. Submitted (`screen: 'done'`)

Centered: a 44px `--ok-strong-t` circle with ✓, "Review submitted to !2841", and a sentence composed
from the actual result ("8 inline comments posted as one review thread, changes requested.
3 dismissed findings stayed local."). Buttons: "Track replies" (`--accent`, opens Posted reviews),
"Back to dashboard", "Open MR in GitLab".

### 9. Posted reviews (`screen: 'threads'`)

**Purpose:** track author replies across every review you submitted in the pod.

**Layout:** a header ("Reviews you contributed to · <pod>", plus "N on you"), then a table of
reviewed MRs on a `minmax(0,1fr) 190px 92px 58px` grid — MR ref + title, a per-MR thread breakdown
("1 you · 1 author · 2 closed"), a badge ("1 waiting on you" in `--sev-minor` tint, or "nothing on
you" in grey), project, age. The selected row gets `--sel`.

Below it, a selected-review bar (`--bg2`): ref · title, a subline (project · submitted N ago ·
agent), three counts (waiting on you / waiting on the author / closed, values 15px/600 in
`--sev-minor` / `--fg-dim` / `--ok`), and "Re-run agent on the fix".

Then the thread list. Each collapsed row: severity chip, title, location, and a status chip —
`awaiting author` (grey), `replied` (`--sev-minor`), `resolved` (`--ok`), `conceded` (grey),
`thread stale` (`--sev-major`). Expanding shows, in order:

1. Your posted comment — 2px `--accent` left border on `--sel-soft`, label "you · posted comment".
2. The author's reply — 2px `--sev-minor` left border on `--sev-minor-t`, label "@kai · 2h ago".
3. For stale threads, a ⚠ line: "Line moved in 2 new commits — GitLab dropped the anchor."
4. On demand, the agent's second opinion — 2px `--agent` left border on `--agent-f`, label
   "agent · second opinion". This must answer the author's actual argument, not restate the finding.
5. For closed threads, "✓ fixed in 4f19c2 · @kai" plus "Re-open thread".
6. For open threads, the action row: "Ask the agent" (`--agent` text and border),
   "Resolve thread" (`--ok-strong`), "Concede — they're right", and a "Reply ⌘↩" hint.

**Sidebar in this state:** a status summary (three dot rows) over a list of the review's threads with
per-thread status dots; clicking one selects it. Footer: "Open posted review". Triage counters and
filter pills must NOT appear here.

### 10. Agent tuning (`screen: 'tuning'`)

860px column. Header: agent name in 11px `--agent`, a 22px/600 headline "56% accepted", and a subline
"56 of 100 findings across 14 reviews in this pod · last 30 days".

Two bar charts — **accept rate by category** (sorted best-first; label column 150px, 6px track,
percentage and `accepted/produced` right-aligned; bars green ≥70%, amber ≥40%, red below; categories
that are switched off render dimmed with a "· off" suffix) and **accept rate by agent confidence**
(bands 90–100 / 80–89 / 70–79 / below 70).

Then **Tune the criteria**: one card per suggestion — title, a body that quotes the numbers
("Style produced 19 findings and you accepted 2. That is 17 items of triage for 2 useful ones."), and
an action button that writes the change into the pod criteria and then reads "✓ applied" with a
disabled look. Suggestions are generated, not fixed: turn off any enabled category accepted under
25%; raise the confidence floor to 80% when it is lower; stop reporting nits when the floor is nit.
When none apply, an empty state says so explicitly. Footer note: "Applied changes land in this pod's
review criteria — the next run uses them."

### 11. Settings (`screen: 'settings'`)

820px column, 26px gaps. Sections:

- **Connection** — a card with the instance URL (12.5px/500 JetBrains Mono), a status line
  ("connected as @you · api scope · token expires in 42 days" in `--ok`), a masked token, and
  "Rotate token".
- **Notifications** — seven event rows, each with a label, a hint, and a four-segment mode switch
  **Interrupt / Badge / Digest / Off** in a `--bg3` container (active `--accent`; active "Off" is
  `--line3`). Events and defaults: agent finished a review → Interrupt; reply on a comment you posted
  → Interrupt; author pushed a fix → Badge; pipeline failed → Digest; review requested from you →
  Interrupt; you were mentioned → Badge; a posted thread went stale → Digest. Then a "Quiet hours"
  checkbox whose note changes with its state, and a digest cadence chip row (Hourly / Twice a day /
  End of day).
- **Data & privacy** — a paragraph stating exactly what leaves the machine ("Diff hunks, file paths
  and your criteria go to the Copilot agent you selected. Nothing reaches GitLab until you press
  Submit — rejected findings and their rationale never leave this machine."), plus a
  "Share accept/reject rates with your team" toggle whose note explains both states.
- **settings.json** — a live 12px/1.75 JetBrains Mono preview of the `codeVerdict.*` keys reflecting
  every control above, with an "Open in editor" link and a note that the token is not a setting.

### 12. Keyboard overlay

Triggered by `?` anywhere, dismissed by `Esc` or a scrim click. Absolutely positioned over the whole
window (`inset: 0`, z-index 40, `rgba(0,0,0,.58)` scrim, 36px padding). Panel: 720px, `--bg3`,
1px `--line2`, 8px radius, `0 20px 60px rgba(0,0,0,.6)`, `animation: tin .18s ease-out`. Header
"Keyboard" + "shortcuts apply when the review tab has focus" + an "Esc" affordance. Body is a
2-column grid of four groups; each shortcut is a min-74px key cap (11px/500 JetBrains Mono, `--bg2`,
1px `--line2`, 4px radius, centered) plus a 12px label and an optional 10.5px note.

Groups: **Triage** — A accept (applies the suggested fix when there is one), ⇧A accept comment-only,
R reject, S skip, J/K next/previous, 1–4 jump to severity, U undo. **Agent** — ⌘↩ ask, E explain,
F show fix, ⇧F find similar. **Navigation** — ⌘1/⌘2/⌘3 mode, O open in editor, G then D dashboard,
G then P posted reviews, ⌘↵ generate summary. **Everywhere** — ? help, ⌘⇧P palette, Esc close.

### 13. Notifications (toasts)

Bottom-right stack, 352px wide, 18px inset, 10px gap, `pointer-events: none` on the container and
`auto` on each toast. Each toast: `--bg3`, 1px `--line2`, 6px radius,
`0 8px 24px rgba(0,0,0,.55)`, `animation: tin .2s ease-out`. Header row: a 13px monospace icon
(◈ `--agent` for agent events, ✕ `--sev-blocker` for pipelines, ✓ `--ok` for confirmations), a
12.5px/500 title, and a ✕. Rich toasts add a 34px-indented body with an 11.5px detail line and two
buttons ("Start triage" `--accent`, "Later" outlined).

Titles are MR-first, never brand-first: "Review ready · 8 items on !2841",
"Pipeline #90412 failed · e2e:chrome", "Review posted · 8 inline comments on !2841".

### 14. Status bar

26px tall, `--accent` background, white text, 11.5px, 16px gaps:
`⎇ feat/auth-refresh` · `◈ Verdict: !2841 · 5 left` · `✕ 1 ⚠ 0` · (right) agent name · `? keys` ·
`🔔 2`. The Verdict segment is state-dependent: on posted reviews it reads
"◈ Verdict: !2833 · 3 replies waiting on you" (or "2 of 7 threads closed"); with no review it reads
"◈ Verdict: no active review".


### 15. Changeset (`screen: 'changeset'`)

**Purpose:** review a group of merge requests that ship together, across repositories, as one unit.
A service split makes the unit of change larger than the unit of review — four MRs can each be green
and individually correct while the combination is broken.

**Entry points:** the sidebar **Changesets** row (with an "N open" count), a two-up band above the
dashboard MR table, or any member MR.

**Dashboard band.** Section label "Changesets" plus the subtitle "merge requests that ship together",
then a 2-column grid of cards: a ⧉ in `--agent`, the name (12.5px/500), a meta line
("4 MRs · 4 projects"), and a state chip — "2 blocked" (`--sev-blocker`), "N to review"
(`--sev-major`) or "ready to merge" (`--ok`). Active card takes an `--accent` border and
`--sel-soft` background.

**Screen layout:** 900px column, 26px/30px padding, 24px gaps. Four sections:

1. **Header** — ⧉ + name (19px/600) + a linked-issue chip (`#1180`, 10.5px JetBrains Mono on
   `--bg3`), then a 12px JetBrains Mono subline:
   `4 merge requests · 4 projects · +812 −247 · detected from Part-of: #1180 in every description`.
   The diff total is the literal sum of the members'.
2. **Readiness strip** — a bordered row with three metrics (pipelines 4/4, reviewed 1/4, cross-repo
   blockers 2; values 15px/600 JetBrains Mono, green when satisfied, `--sev-major` when not) and a
   sentence stating the trap: "Pipelines are green, but 2 findings only exist between these repos —
   each MR is clean on its own."
3. **Findings that only exist between these repos** — the payload of the whole feature, labelled
   "agent read all 4 diffs together" in `--agent`. Each is a clickable card: severity chip, title,
   confidence, then **both sides** as two rows — project in `--agent` (96px column), location in
   `--fg` JetBrains Mono, and the role in system-ui `--fg-dimmer` ("renames the field" /
   "still reads the old name"). Hover border `--agent`. Clicking opens the item in triage.
4. **Merge order** — "derived from what each MR reads and writes". Numbered steps (20px `--bg3`
   circles) with `!381 · Propagate rotated key ids`, the project, a reason line
   ("reads the renamed field — merge last or the banner breaks"), and that MR's review chip and
   pipeline state right-aligned. Clicking a step opens that MR alone.

**Footer:** "Review all 4 MRs together" (`--brand`), "Back to dashboard", and a note —
"One agent run over every diff · one summary posted to all 4 MRs".

**Triage in changeset scope.** The normal triage screen with five differences:

- A scope banner above the header on `--agent-f`: "⧉ Reviewing <name> · 4 MRs · findings are
  labelled with the repo they land in", with a **Review this MR alone** link on the right.
- The chrome names the changeset: sidebar reads `⧉ <name>` over "4 MRs · 4 repos" with the summed
  diff stat; the tab reads "Verdict: Review · 4 MRs"; the header subline lists every ref; the status
  bar reads "⧉ Verdict: 4 MRs · N left".
- Each item's meta row leads with its repo and owning MR (`api-gateway · !381` in `--agent`), and
  the sidebar tree prefixes each file group with its repo — without this, two `session.ts` files
  from different repos are indistinguishable.
- Cross-repo items carry a ⧉ glyph in the tree and a "cross-repo" chip in the list, and their detail
  opens with a **spans two repositories** block (1px `--agent-b`, 3px `--agent` left edge,
  `--agent-f` fill) listing both sides with their roles. The severity dot keeps its severity colour.
- The third filter pill becomes **Cross-repo N** instead of Security.

**Submit in changeset scope.** Each accepted item posts to the MR named by its `mrIid`; a cross-repo
finding posts to the side that must change with the other side quoted; the summary is posted to every
member MR, cross-linked to the issue. The comment rows are prefixed with their repo, the button reads
"Submit across 4 MRs", and a ⧉ note above the list states where everything lands.

**Out of scope for v1:** Verdict recommends a merge order and shows readiness. It does not merge, gate
GitLab, or create merge trains.

---

## Interactions & behavior

**Navigation.** Sidebar nav rows switch screens (Pod dashboard / Posted reviews / Agent tuning /
Settings). Editor tabs are synthetic in the prototype but mirror the open screens; the review tab's
label changes with state ("Verdict: Run review · !2841" → "Verdict: Review · !2841" → "Verdict:
Posted · !2841").

**Triage verdicts.** A verdict records `{verdict, applyFix}` for the item and, when
`codeVerdict.autoAdvance` is on (default), advances to the next *undecided* item — falling back to
the first undecided one, and staying put when none remain. With auto-advance off, the selection does
not move. Deciding in any mode updates all three modes, the sidebar tree, the verdict bar, the status
bar and the summary.

**Deep dive.** Each preset appends one thread entry per item (idempotent — asking twice does not
duplicate). Entries persist with the review and are visible in all three triage modes.

**Summary gating.** "Generate summary" is inert until every item has a verdict; the button's fill
communicates this.

**Submit.** Posts line comments for accepted items only, then the summary note. On failure nothing is
lost: the draft, the comment list and the final note survive, and the user gets Reconnect or Retry.

**Thread actions.** Resolve / Concede / Re-open write per-thread status keyed by `<mrRef>:<itemId>` —
status must not be shared between reviews. "Ask the agent" fetches a second opinion for that thread.

**Tuning.** Applying a suggestion mutates the pod criteria immediately and marks the suggestion
applied; the suggestion list recomputes from the new criteria.

**Animations.** Only two, both deliberate: `tin` (8px rise + fade, 180–200ms ease-out) for cards,
toasts, peek widgets and the overlay; `spin` (800ms linear infinite) for the run spinner. The run
progress bar transitions width at `.5s ease`. Everything else is instant — this is a tool, not a
showcase.

**Hover states.** Buttons lighten one step (`--line` → `--hover`, `--accent` → `--accent-h`,
`--ok-strong` → `--ok-strong-h`, `--brand` → `--brand-h`). Table rows take `--bg3`. Preset chips take
an `--accent` or `--agent` border. Destructive buttons take a tinted background rather than a fill.

**Failure states.** Five, all reachable in the prototype via its Scenario tweak: agent found nothing,
agent failed, MR updated mid-triage, submit failed, empty pod. See the screens above and section 2 of
`specs/Code Verdict - developer handoff.md`.

---

## State management

The prototype holds everything in one component. A real implementation should split it: pods and
criteria in extension global state, the active review in workspace state, thread status keyed by MR,
and per-webview view state for selection and mode.

| State | Type | Notes |
| --- | --- | --- |
| `screen` | enum | onboard, dashboard, agent, running, triage, clean, summary, done, threads, tuning, settings, changeset |
| `step` | 1–3 | onboarding step; gated by `connected`, `draftName`, resolved projects |
| `instance`, `token`, `connected` | string/bool | token belongs in `SecretStorage` |
| `pods`, `podIdx` | Pod[] | see the domain model in the handoff spec |
| `sources`, `groupSel`, `paste`, `draftName` | — | onboarding step 3 working state |
| `projFilter`, `scope` | string/enum | dashboard filters; scope = all / waiting-on-you / waiting-on-them |
| `mrIdx` | index | the active merge request; drives every chrome label |
| `agent`, `sevMin`, `conf`, `cats` | — | pod criteria |
| `runStep`, `runError` | number/bool | run progress and the timeout branch |
| `sel`, `mode`, `filter` | — | triage selection, mode, list filter |
| `decisions`, `applied` | Record&lt;itemId, …&gt; | verdicts and whether the fix is attached |
| `thread` | Record&lt;itemId, entry[]&gt; | deep-dive answers |
| `note`, `postThread`, `requestChanges` | — | summary options |
| `submitted`, `submitError`, `submitRetried` | — | submit outcome |
| `threadMR`, `threadSel`, `threadStatus`, `threadAsked` | — | posted-review tracking, keyed `<mrRef>:<itemId>` |
| `notif`, `quiet`, `digest`, `telemetry` | — | settings |
| `csIdx`, `csScope` | index/bool | active changeset, and whether triage is scoped to it |
| `helpOpen` | bool | keyboard overlay |
| `staleResolved` | bool | cleared by "Re-anchor to HEAD" |

**Data fetching:** one query per pod (merge requests, issues, pipelines), cached and refreshed on
focus plus an interval; discussions polled per submitted review to derive thread status. Never fan
out one request per MR where a project-level query suffices. Endpoints are listed in section 12 of
the handoff spec; example payloads are in `specs/Code Verdict - API fixtures.json`.

---

## Design tokens

Map these to VS Code theme variables; the hexes are the Dark+ resolutions for verification.

**Surfaces:** `--bg` #1f1f1f (editor) · `--bg2` #181818 (sidebar, headers, footers) · `--bg3` #252525
(hover, segmented controls, overlay panel) · `--card` #242424 (raised cards, peek widgets) ·
`--code` #141414 (code blocks) · `--row` #232323 (table row dividers)

**Lines:** `--line` #2b2b2b (section borders) · `--line2` #3c3c3c (control borders) · `--line3`
#4a4a4a (inactive radio) · `--hover` #383838 (button hover)

**Text:** `--fg-max` #f0f0f0 (headings) · `--fg-hi` #e8e8e8 (primary) · `--fg` #cccccc (body) ·
`--fg2` #bdbdbd (secondary body) · `--fg-dim` #9d9d9d (labels) · `--fg-dim2` #8b8b8b ·
`--fg-dimmer` #6e7681 (meta, hints) · `--gutter` #5a5a5a (diff line numbers)

**Accents:** `--accent` #0078d4 / hover #1a86e0 (primary action, selection, status bar) · `--sel`
#04395e (selected row) · `--sel-soft` #04395e33 · `--brand` #fc6d26 / hover #ff8144 (GitLab actions:
submit, create pod, run) · `--agent` #a371f7 (Copilot agent), tints `--agent-t` #a371f722,
`--agent-b` #a371f755, `--agent-f` #a371f70f · `--link` #4daafc

**Semantic:** `--sev-blocker` #f85149 (tint #f8514922, border #f8514966) · `--sev-major` #d29922
(tint #d2992222) · `--sev-minor` #4a9eff (tint #4a9eff22) · nit tint #8b8b8b22 · `--ok` #3fb950
(tint #3fb95022) · `--ok-strong` #238636 / hover #2ea043 (accept buttons) · `--add-bg` #1b3a24 /
`--add-fg` #8ddaa0 · `--del-bg` #3a1e1e / `--del-fg` #f0a5a2

**Light-theme overrides** (contrast-corrected, not derived): blocker #b3252b · major #8a6100 ·
minor #0b62c4 · ok #116329 · agent #6b3fc7 · brand #b8341d · link #0066bf · dim text #595959.

**Type.** UI: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`).
Code, ids, paths, counts and metadata: **JetBrains Mono**. Scale — 27px/600 stat values ·
22px/600 tuning headline · 19px/600 screen headings · 18px/600 queue card title · 17px/600 product
name · 15.5px/600 item title · 14px/600 pod name · 13.5px/600 section heading · 13px body ·
12.5px row title and body prose · 12px labels and diff text · 11.5px hints · 11px meta ·
10.5px counts · 10px/500 uppercase section labels (.09em tracking) · 9.5px/600 severity chips
(.06–.07em tracking). Line-height 1 for chrome, 1.3–1.4 for titles, 1.6–1.75 for prose, 1.75–1.9 for
code. Minimum size 10px, and only for uppercase tracked labels.

**Spacing.** 3 · 4 · 6 · 7 · 8 · 9 · 10 · 11 · 12 · 14 · 16 · 18 · 20 · 22 · 26 · 30 · 40. Screen
padding 26px/30px; table rows 11–12px vertical, 20px horizontal; cards 13–15px; sidebar rows
6–8px/12px. Groups are laid out with flex/grid + `gap`, never margins on siblings.

**Radii.** 3px chips and pills · 4px buttons · 5px inputs and larger buttons · 6px cards ·
8px modals and the window shell · 11–16px capsule chips · 50% dots and radios.

**Shadows.** Dropdowns `0 10px 28px rgba(0,0,0,.5)` · toasts `0 8px 24px rgba(0,0,0,.55)` ·
modal `0 20px 60px rgba(0,0,0,.6)` · window shell `0 12px 40px rgba(0,0,0,.5)`.

---

## Assets

`assets/` holds eight PNGs captured from the prototype at 1440×920, used by the marketplace listing
and the walkthrough. **Replace them with captures from the real extension before publishing** — keep
the names and aspect.

| File | State |
| --- | --- |
| `shot-dashboard.png` | Pod dashboard, all projects |
| `shot-triage.png` | Triage, split mode, blocker open |
| `shot-diff.png` | Triage, in-diff mode, suggestion visible |
| `shot-tuning.png` | Agent tuning scorecard |
| `wt-connect.png` | Onboarding step 1 |
| `wt-projects.png` | Onboarding step 3, group expanded |
| `wt-triage.png` | Triage (walkthrough step 3) |
| `wt-keys.png` | Keyboard overlay |

**Icon.** Typographic, not illustrative: square brackets closing around a check — `[✓]` — in
JetBrains Mono Bold on a near-black (#111) rounded tile. Brackets in `--fg-dimmer`, check in
`--brand`. At 24px (activity bar) the brackets drop and the check goes solid white on a `--brand`
tile. Ship as SVG with the glyph converted to outlines (no font dependency) plus a 128px PNG for the
marketplace; the light-theme tile darkens the check to #b8341d. Design and rationale are in the
marketplace prototype, section C.

**Fonts.** JetBrains Mono (SIL Open Font License) — in the real extension, prefer the user's
`editor.fontFamily` for code and metadata rather than bundling a font.

No third-party icon set is used; the few glyphs (◈ ▦ ◍ ◔ ⚙ ✓ ✕ ⚠ ⤼ ⎇ ▸ ▾) are Unicode. Replace them
with VS Code's Codicons in the real extension.

---

## Files

**`prototypes/`**

| File | What it is |
| --- | --- |
| `GitLab AI Review - Prototype.dc.html` | The main prototype — every screen and failure state, clickable end to end. Open this first. |
| `Code Verdict - Marketplace.dc.html` | Post-install walkthrough, marketplace listing, and the icon at every size. |
| `GitLab AI Review - Explorations.dc.html` | The eight original design directions. Context only — not a spec. |
| `support.js`, `image-slot.js` | Runtime files the prototypes load. Not part of the product. |

Open the HTML files directly in a browser. In the main prototype, a **Scenario** control (Happy path,
Agent found nothing, Agent failed, MR updated mid-triage, Submit failed, Empty pod) walks the failure
branches, and Theme / Accent / Agent voice / Auto-advance controls demonstrate the theming and
behaviour requirements. Press `?` for the keyboard overlay.

**`specs/`**

| File | What it is |
| --- | --- |
| `Code Verdict - developer handoff.md` | State machine, TypeScript domain model, source-resolution rules, review-run contract, submit and thread semantics, GitLab endpoint list, v1 definition of done. |
| `Code Verdict - naming & commands.md` | Name rules, the 19 `Verdict:` commands with ids, keybinding scoping, the `codeVerdict.*` settings namespace, shipped UI strings, fixed vocabulary. |
| `Code Verdict - API fixtures.json` | One reference payload per contract: agent response (with filtered-out candidates), MR, line-comment POST with suggestion + position, summary note, discussions response annotated with derived thread status, and the five error shapes. |

**Known scope gaps to confirm with product before building:** pipeline and issue screens are
list-only (no detail view); the notification digest is specified but not designed; and changeset
**detection** assumes a `Part-of:` trailer with shared-branch-name as a fallback — confirm which
convention your teams actually use, and make it a setting. Merge coordination (actually merging in the
recommended order) is deliberately out of scope.

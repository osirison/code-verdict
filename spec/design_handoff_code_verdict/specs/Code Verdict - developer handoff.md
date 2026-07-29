# Code Verdict — developer handoff

Companion to `Code Verdict — naming & commands.md` (names, command ids, settings keys) and the
clickable prototype `GitLab AI Review - Prototype.dc.html`. This document describes what to build,
not how the prototype is coded — the prototype is a spec of behaviour, not source to port.

---

## 1. What the extension is

A VS Code extension that turns an AI review of a GitLab merge request into a human decision. Three
surfaces:

| Surface | Contents |
| --- | --- |
| Activity-bar view (sidebar, ~308px) | Pod dashboard link, posted reviews, agent tuning, settings; MR identity + review-item tree while a review is open |
| Editor-tab webviews | Setup, Dashboard, Run review, Triage, Summary, Posted reviews, Agent tuning, Settings |
| Editor decorations | Review items rendered as a peek widget anchored to their lines (the "In diff" triage mode) |
| Status bar | `◈ Verdict: !2841 · 5 left`, branch, agent, `? keys`, notification count |

---

## 2. Screen inventory and state machine

States, as implemented in the prototype (`screen` in the logic class):

```
onboard ──▶ dashboard ──▶ agent ──▶ running ──┬──▶ triage ──▶ summary ──▶ done ──▶ threads
                 ▲                            ├──▶ clean  (no findings above criteria)
                 │                            └──▶ running+runError (timeout / rate limit)
                 ├── changeset (a group of MRs reviewed as one unit)
                 ├── threads   (posted reviews; also reachable from a submitted MR row)
                 ├── tuning    (agent scorecard)
                 └── settings
```

Onboarding is a 3-step wizard inside `onboard`: **1 Connect** (instance + token, test connection) →
**2 Pod** (name) → **3 Projects** (add sources). Steps are gated: 1 requires a successful
connection test, 2 a non-empty name, 3 at least one resolved project.

Failure branches that must exist in the real extension:

| Branch | Trigger | UI |
| --- | --- | --- |
| Clean bill | Agent returns nothing above severity floor + confidence | `clean` screen: what was filtered out, Approve MR, or lower the bar and re-run |
| Agent failure | Copilot request times out / errors / rate-limits | Error card on `running`: partial findings count, Use partial, Retry, switch agent, request id |
| Stale anchors | New commits on the source branch during triage | Banner on `triage`, affected items flagged, Re-anchor to HEAD or Re-run agent |
| Submit failure | GitLab 401/409/network on submit | Banner on `summary`, draft preserved, Reconnect or Retry |
| Empty pod | Pod has no open MRs | Dashboard empty state; no table header, no filter chips, no issues section |

---

## 3. Domain model

```ts
type Pod = {
  id: string;
  name: string;
  sources: Array<
    | { kind: 'project'; projectId: string }
    | { kind: 'group'; groupId: string; projectIds: string[] } // explicit selection, not "all"
  >;
  criteria: Criteria;          // per pod, not per MR
  agentId: string;
};

type Criteria = {
  severityFloor: 'nit' | 'minor' | 'major' | 'blocker';
  categories: Category[];      // subset of the nine below
  minConfidence: number;       // 0-100
  extraInstructions: string;
};

type Category =
  | 'security' | 'concurrency' | 'errorHandling' | 'performance' | 'craftsmanship'
  | 'apiContract' | 'tests' | 'docs' | 'style';

type ReviewItem = {
  id: string;
  file: string; line: number;   // anchor as reported by the agent
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  category: Category;
  confidence: number;           // 0-100
  title: string;                // one line, imperative or diagnostic
  body: string;                 // 1-3 sentences
  code: string;                 // the offending hunk
  projectId?: string;           // required in a changeset review — which repo the finding lands in
  mrIid?: string;               // which MR the comment is posted to
  cross?: boolean;              // true when the finding only exists between repos
  spans?: Array<{ projectId: string; location: string; role: string }>;  // both sides of a cross-repo finding
  suggestion?: { old: string; new: string };  // becomes a GitLab suggestion block
  answers?: Partial<Record<'explain' | 'fix' | 'similar' | 'why', string>>; // preset follow-ups
};

type Changeset = {
  id: string;
  podId: string;
  name: string;
  mrs: Array<{ projectId: string; iid: string }>;
  detection: 'trailer' | 'branch' | 'manual';  // how the group was found
  detectionDetail: string;                     // "Part-of: #1180 in every description"
  linkedIssue?: string;                        // "#1180"
  mergeOrder: Array<{ iid: string; projectId: string; reason: string }>;
};

type Verdict = 'accepted' | 'rejected' | 'skipped';

type Review = {
  mrIid: string; projectId: string; agentId: string; criteria: Criteria;
  headSha: string;              // what the agent read — compare against MR head to detect staleness
  items: ReviewItem[];
  verdicts: Record<string /* itemId */, { verdict: Verdict; applyFix: boolean; note?: string }>;
  summary: string;              // generated, user-editable
  finalNote?: string;
  submittedAt?: string;
};

type Thread = {                 // after submit
  itemId: string; discussionId: string;
  status: 'awaiting' | 'replied' | 'resolved' | 'conceded' | 'stale';
  replies: Array<{ author: string; at: string; body: string }>;
  closedBy?: string;            // "fixed in <sha> · @author"
};
```

Persistence: pods, criteria and verdict history in `globalState` (or `workspaceState` when the pod
maps to the open folder); token in `SecretStorage`; nothing user-identifying in `settings.json`.

---

## 4. Source resolution (onboarding step 3)

One input accepts three shapes; detect and echo the detection before the user commits:

| Input | Rule | Result |
| --- | --- | --- |
| `https://gitlab.com/hve/platform/core` | strip origin, drop `/-/…` suffix and `.git` | project by path |
| `9102` | all digits | project by id — or group by id if it matches a group |
| `group 4821`, `.../groups/hve/platform` | `group:` prefix or `/groups/` in the path | group; expand to its projects |
| anything else | — | show "no match — check the id or paste the full URL"; never silently add |

A group resolves to a **project chooser**: all-projects toggle plus per-project checkboxes with
open-MR counts. Store the resolved project ids, not "all", so a new project added to the group later
does not silently join the pod.

---

## 5. Review run

1. Resolve the agent from the Copilot workspace (`vscode.lm` / chat participant discovery). Agents
   are whatever the user has — the extension must not ship its own prompt as the only option.
2. Send: changed-file diffs, file paths, the pod criteria, and `extraInstructions`. Not the whole
   repo unless the agent asks for it.
3. Expect back the `ReviewItem[]` shape above. Items failing the criteria filter are kept but
   collapsed — the `clean` screen reports them as "filtered out", which is what makes a no-findings
   result trustworthy.
4. Record `headSha` at request time.
5. Progress UI is a log, not a spinner: resolving agent → indexing N files → cross-referencing →
   scoring → N items ready.

Timeout at 90s per request with the partial-results path above. Surface the request id for support.

---

## 6. Triage

Three modes over one state (`Split`, `Queue`, `In diff`) — a verdict in any mode updates all of
them, plus the sidebar tree, progress bar, status bar and summary.

- Verdicts: `A` accept (applies suggestion when present), `⇧A` accept comment-only, `R` reject,
  `S` skip, `J/K` move, `U` undo, `?` help. Bind under `when: verdict.reviewFocus`.
- Auto-advance to the next undecided item is a setting (`codeVerdict.autoAdvance`), on by default.
- Deep dive: four preset follow-ups (explain / fix / similar / why flagged) plus freeform. Answers
  append to a per-item thread and persist with the review.
- "Generate summary" unlocks only when every item has a verdict.

Staleness: poll the MR head (or use webhooks where available). If `headSha` moved, mark items whose
anchor no longer resolves, show the banner, and offer re-anchor (recompute line numbers from the new
diff) or re-run.

---

## 7. Submit

Posted for an **accepted** item: one discussion on the item's line, body = item title + body +
rationale, plus a GitLab suggestion block when `applyFix` is set. Rejected and skipped items are
never posted; their rationale stays local (it feeds agent tuning).

Also posted: the summary comment (generated from the accepted set, user-editable, tone follows
`codeVerdict.agentVoice`) and the optional final note, appended to it. Options: post as a single
review thread, and request changes.

Failure handling: nothing is posted until the batch succeeds, or the extension reconciles what
landed and retries only the remainder. The draft must survive a 401.

---

## 8. Posted reviews

Lists every MR in the pod you have submitted a review on, with per-MR thread counts split
**waiting on you / awaiting author / closed**. Drill into one to see each thread: your comment, the
author's replies, an on-demand **agent second opinion** that answers the author's actual argument,
and actions Resolve / Concede / Re-open, plus "Re-run agent on the fix".

Thread status derivation:

| Status | Condition |
| --- | --- |
| `awaiting` | posted, no reply yet |
| `replied` | last note is not yours |
| `resolved` | GitLab discussion resolved, or the line changed in a commit that addresses it |
| `conceded` | you closed it agreeing with the author (local flag + resolved in GitLab) |
| `stale` | GitLab dropped the anchor (force-push / rebase) |

`waiting on you` = `replied` + `stale`. This drives the sidebar badge and the dashboard's
"Waiting on you" stat.

---

## 9. Dashboard

Pod-scoped, never global: pod switcher, four stat cards (Waiting on you, AI review coverage,
Pipelines failing, Projects in pod), scope pills (All / Waiting on you / Waiting on them), per-project
filter chips, then MRs (title, project, AI review state, pipeline, age), issues, activity feed and
recent pipelines. Every number on this screen must derive from the same pod query — the prototype's
recurring bug class was hardcoded counts contradicting derived ones.

MR row click: submitted MRs open Posted reviews, everything else opens Run review.

---

## 10. Agent tuning

Aggregate the verdict history: accept rate overall, by category, by confidence band. Then suggest
concrete criteria changes and apply them to the pod on click — turn off a category accepted under
25% of the time, raise the confidence floor, stop reporting nits. Empty state when the criteria
already match the data. Optional pooling across the pod is a privacy setting, off by default.

---

## 11. Notifications

Per-event mode: **Interrupt / Badge / Digest / Off**, defaults: agent finished, reply, review
requested → Interrupt; author pushed a fix, mention → Badge; pipeline failed, thread went stale →
Digest. Quiet hours (18:00–09:00 by default) demote everything except blockers and direct mentions.
Digest cadence: hourly / twice a day / end of day. Toast titles stay MR-first
("Review ready · 8 items on !2841"), never brand-first.

---

## 12. GitLab API surface

REST v4 (or GraphQL equivalents) needed:

- `GET /groups/:id`, `GET /groups/:id/projects` — source resolution and the project chooser
- `GET /projects/:id` — id/path resolution
- `GET /merge_requests?scope=all&state=opened` per project — dashboard
- `GET /projects/:id/merge_requests/:iid/changes` — diffs for the agent, and `diff_refs` for anchors
- `POST /projects/:id/merge_requests/:iid/discussions` — line comments with `position`
- `PUT …/discussions/:id/resolve` — resolve / re-open
- `GET …/discussions` — reply polling for thread status
- `POST …/notes` — summary comment
- `POST …/approve`, `PUT …/merge_requests/:iid` — approve / request changes
- `GET /projects/:id/pipelines`, `GET /projects/:id/issues` — dashboard panels

Rate limits: cache per pod, poll on focus plus a background interval, and never fan out one request
per MR when a project-level query will do.

---

## 13. Definition of done for v1

- Onboarding resolves URL / project id / group id, with a project chooser for groups.
- A review runs on a real MR with a user-selected Copilot agent, and every item carries severity,
  category, confidence and an anchor.
- All three triage modes share state; keyboard verdicts work; deep-dive answers persist.
- Submit posts line comments with suggestions, a summary, and optionally requests changes.
- All five failure branches are reachable and lose no user work.
- Posted reviews tracks replies across every MR you reviewed in the pod.
- Every count on every screen derives from one query per pod.

---

## 14. Reference payloads

`Code Verdict — API fixtures.json` carries one concrete example per shape in section 3, matching the
prototype's demo data so the UI can be built before the integration lands:

| Key | What it is |
| --- | --- |
| `agentReviewResponse` | What a Copilot review agent must return, including `headSha`, `stats`, and `candidates` (findings filtered out by the criteria — these power the "no findings" screen) |
| `gitlabMergeRequest` | The MR fields the dashboard reads, with `diff_refs` for anchor validation |
| `postDiscussionRequest` | One accepted item as a line comment, with the ```suggestion block and the `position` payload |
| `postSummaryRequest` | The summary note with the final instructions appended |
| `discussionsResponse` | Reply polling, annotated with the `_derivedStatus` each discussion maps to |
| `errorResponses` | The five failure branches as the extension observes them, each naming its UI branch |

Two contract notes that are easy to get wrong:

- **`position` must carry the same `diff_refs` the agent read.** If `head_sha` moved, GitLab returns
  `400 Note position is invalid` — re-anchor before posting, never retry blindly.
- **A dropped anchor comes back as `position: null`, not an error.** That is the `stale` thread status;
  surface it and offer a re-post rather than losing the finding.

## 15. Screenshot inventory

`assets/` holds captures taken from the prototype at 1440×920, used by the marketplace listing and
walkthrough in `Code Verdict — Marketplace.dc.html`. Replace them with captures from the real
extension before publishing; keep the same names and aspect.

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

## 16. Changesets — distributed review across repositories

A **changeset** is a named group of merge requests, spanning projects, that ship together. It exists
because a service split makes the unit of change larger than the unit of review: four MRs can each be
green and each be individually correct while the combination is broken. Reviewing them one at a time
cannot surface that.

### Detection

Offer three routes, in this order of preference:

| Route | Signal | Notes |
| --- | --- | --- |
| `trailer` | `Part-of: #1180` (or a configurable trailer) in every MR description | Most reliable; recommend it to teams |
| `branch` | identical source branch name across projects | Common in practice; noisy if teams reuse names like `fix/ci` |
| `manual` | user adds MRs by URL or picks them from the pod | Always available; never make detection the only path |

Detection runs over the pod's open MRs on refresh. A detected group is a **suggestion** until the
user opens it — never auto-review, and never merge on the user's behalf.

**Confirm the trailer convention with the team before building.** The prototype assumes `Part-of:`;
some organisations use `Depends-On:`, a shared milestone, or an issue link. Make it a setting
(`codeVerdict.changesets.trailer`) with branch-name matching as a fallback that can be switched off.

### Changeset screen

Reached from the sidebar (**Changesets**), the dashboard band above the MR table, or a member MR.
Four sections:

1. **Header** — name, linked issue chip, and a subline: `N merge requests · N projects · +X −Y ·
   detected from <detectionDetail>`. The diff total must be the literal sum of the members'.
2. **Readiness strip** — pipelines green, reviews complete, cross-repo blockers, plus a sentence
   naming the trap: "Pipelines are green, but 2 findings only exist between these repos — each MR is
   clean on its own."
3. **Findings that only exist between these repos** — the payload. Each shows severity, title,
   confidence, and **both sides** with their roles (`api-gateway src/routes/session.ts:88 · renames
   the field` / `console src/api/session.ts:41 · still reads the old name`). Clicking one opens it
   in triage.
4. **Merge order** — an ordered list derived from what each MR reads and writes, each step carrying
   a reason ("reads the renamed field — merge last or the banner breaks"), plus that MR's review and
   pipeline state. Clicking a step opens that MR alone.

Footer: **Review all N MRs together** (primary) and a note — "One agent run over every diff · one
summary posted to all N MRs".

### Changeset review run

One agent request receives **every member diff at once**, with each hunk labelled by project. This is
the only way cross-repo findings can be produced: an agent that sees one repo cannot know the console
reads a field the gateway just renamed.

Items come back in the normal shape plus `projectId`, `mrIid`, and — for findings that span
repositories — `cross: true` and a `spans[]` array naming each side and its role. Cross-repo items
are merged into the same triage queue as the per-repo ones; they are not a separate mode.

### Triage in changeset scope

The existing triage screen, with five differences:

- A scope banner above the header: "⧉ Reviewing <name> · N MRs · findings are labelled with the repo
  they land in", plus a **Review this MR alone** escape.
- The chrome names the changeset, not one member: sidebar reads `⧉ <name>` over `N MRs · N repos`,
  the tab reads `Verdict: Review · N MRs`, the header subline lists every ref, and the status bar
  reads `⧉ Verdict: N MRs · N left`.
- Every item's meta row leads with its repo and owning MR (`api-gateway · !381`), and the sidebar
  tree groups files by repo. Without this, two `session.ts` files from different repos are
  indistinguishable.
- Cross-repo items carry a ⧉ glyph and a "cross-repo" chip, and their detail opens with a
  **spans two repositories** block listing both sides. The severity dot keeps its severity colour —
  the glyph carries the cross-repo signal.
- The third filter pill becomes **Cross-repo N** instead of Security.

### Submit

One triage pass produces one review across N merge requests:

- Each accepted item posts to **the MR named by its `mrIid`** — a finding in the console lands on
  the console MR, not on all of them.
- A cross-repo finding posts to the MR that must change (`spans[0]` by convention, overridable in
  the UI), with the other side quoted in the body so the reader sees both.
- The summary comment is posted to **every** member MR, cross-linked to the changeset's issue, so
  each repo's reviewers see the whole picture.
- The submit button reads "Submit across N MRs"; the summary screen states where the comments will
  land.

Partial failure matters more here: if three MRs accept the comments and one 401s, report which
succeeded and retry only the remainder. Never re-post to an MR that already took its comments.

### Merge coordination — explicitly out of scope for v1

Verdict recommends an order and shows readiness. It does **not** merge, does not gate GitLab, and does
not create merge trains. If teams ask for that, it is a separate feature with real consequences —
design it deliberately rather than growing it out of this screen.

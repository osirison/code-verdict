<!-- markdownlint-disable-file -->

# Remaining Review States Details

## Phase 1: In-Diff Triage

Extend `FlowViewState.mode`, parse the selected file's hunks, render numbered added/deleted/context lines, insert the selected item widget after its anchor, and dispatch verdicts through the existing message reducer.

## Phase 2: Changeset Detection

Add optional description metadata to the neutral change-request model and GitLab mapper. Group open changes by `Part-of: #<number>` only when at least two members share a trailer.

## Phase 3: Changeset Overview

Project detected groups into dashboard cards. Open a panel that fetches member diffs for summed stats and renders readiness plus merge-order members. Do not render cross-repo findings before a multi-diff agent run exists.

## Phase 4: Validation

Run focused tests after each edit, then the full Vitest suite, TypeScript, ESLint, and esbuild.

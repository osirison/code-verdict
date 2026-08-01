<!-- markdownlint-disable-file -->

# Combined Changeset Reviews Details

## Agent Phase

Represent each member as its change request, project path, and diff. Demo execution aggregates normal per-repo findings and detects the seeded gateway-console contract mismatch. LM execution sends all labelled hunks in one request and validates routing plus anchors after parsing.

## Submission Phase

Build one member plan per merge request. Use each member's own anchor refs. Append cross-repository span context to cross findings. Persist successful comment keys, summary refs, and request-change refs. Retry only absent operations.

## UI Phase

Reuse `renderReviewFlowHtml` with optional changeset scope. Add the scope banner, repository and MR metadata, cross-repository span card, changeset summary routing, and changeset-specific tab labels. Keep split, queue, and in-diff verdict state shared.

## Controller Phase

A changeset review panel owns combined loading, execution, drafts, triage, summary, and submission. Member rows still open the existing single-MR review panel.

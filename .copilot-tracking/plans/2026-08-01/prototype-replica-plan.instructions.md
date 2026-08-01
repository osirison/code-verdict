<!-- markdownlint-disable-file -->
---
description: "Plan for reproducing the Code Verdict prototype with emulator-backed live data"
applyTo: "src/**, emulator/**"
---

## User Requests

* Create an exact replica of the prototype specification for the extension.
* Use the emulator so the extension works with real data.
* Restore missing navigation, pod list, issue list, typography, and layout.

## Objectives

1. Make every product-owned prototype screen available in the extension.
2. Drive each displayed collection and count from the active pod query or
   persisted review state.
3. Validate every supported screen against emulator scenarios and automated
   tests.

## Context Summary

* `spec/README.md` is the behavioral source of truth.
* The prototype HTML is a visual reference and must not recreate VS Code
  chrome.
* `emulator/README.md` documents the live acceptance environment.

## Implementation Checklist

### Phase 1: Navigation and Dashboard Foundation

<!-- parallelizable: false -->

- [x] Replace the native tree navigation with a prototype-style webview sidebar.
- [x] Render active pods, dashboard navigation, merge requests, and issues from
      the live active-pod query.
- [x] Keep pod switching and review opening functional from the sidebar.
- [x] Cover sidebar markup and state projection with tests.

### Phase 2: Review Fidelity

<!-- parallelizable: false -->

- [ ] Add the triage sidebar and in-diff review presentation.
- [ ] Synchronize status bar and review state.
- [ ] Add the keyboard overlay.

### Phase 3: Remaining Product Screens

<!-- parallelizable: false -->

- [ ] Implement onboarding, settings, agent tuning, and notifications.
- [ ] Implement changeset discovery and cross-repository review.

### Phase 4: Emulator Acceptance

<!-- parallelizable: false -->

- [ ] Exercise populated, empty, auth failure, rate limit, stale anchor, push,
      and reply scenarios against the emulator.
- [ ] Add regression coverage for each rendered state.

## Success Criteria

* Product UI follows prototype layout, type scale, spacing, state labels, and
  color semantics while retaining VS Code supplied chrome.
* No UI collection or statistic is hardcoded when live provider data exists.
* `npm test`, `npm run typecheck`, and `npm run build` pass.
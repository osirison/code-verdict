<!-- markdownlint-disable-file -->

# Single App and Review Sidebar Plan

## User Requests

* Continue suggested work item 2: complete review sidebar parity.
* Use one app surface instead of opening new tabs.
* Add breadcrumb back-navigation.
* Correct the style, colors, UI cleanliness, and UX quality.

## Context

Research: `.copilot-tracking/research/2026-08-01/single-app-review-sidebar-research.md`

Prototype: `spec/prototypes/GitLab AI Review - Prototype.dc.html`

## Implementation Checklist

* [x] Add one shared editor webview host <!-- parallelizable: false -->
* [x] Migrate every feature controller to shared routing <!-- parallelizable: false -->
* [x] Add shell breadcrumbs and in-place back navigation <!-- parallelizable: false -->
* [x] Add active review progress, filters, and finding tree to the sidebar <!-- parallelizable: false -->
* [x] Synchronize sidebar finding focus for single and combined reviews <!-- parallelizable: false -->
* [x] Keep canonical prototype colors independent of host theme <!-- parallelizable: true -->
* [x] Run full validation and runtime review <!-- parallelizable: false -->

## Success Criteria

* All editor features reuse one Verdict webview panel.
* Navigating between routes retires stale handlers and never opens another editor tab.
* Breadcrumb back returns to the dashboard in the same tab.
* Active reviews show progress, filters, verdicts, and findings in the sidebar.
* Sidebar finding selection focuses the corresponding triage item.
* The canonical prototype palette is stable across VS Code host themes.

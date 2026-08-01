<!-- markdownlint-disable-file -->

# Prototype Replica Research

## Scope

Recreate the Code Verdict prototype as a real VS Code extension while using
the emulator as the live data source for every implemented screen.

## Evidence

* `spec/README.md` defines the visual and behavioral contract.
* `spec/prototypes/GitLab AI Review - Prototype.dc.html` provides the
  reference layout and interaction states.
* `emulator/README.md` documents seeded merge requests, issues, pipelines,
  discussions, failure scenarios, and mutation controls.
* The current implementation covers dashboard, review flow, and posted
  reviews, but uses a native tree view for the sidebar and lacks onboarding,
  tuning, settings, notifications, changesets, and in-diff triage.

## Selected Approach

Use custom webviews for surfaces that require prototype-accurate layout and
typography. Preserve VS Code native chrome and extension-host APIs. Derive all
visible data from the active pod and the emulator-backed provider contracts.

## Dependencies

1. A webview sidebar with real pod and review navigation.
2. Shared data refresh and state projection for dashboard, sidebar, and
   status bar.
3. In-diff triage and live review tracking.
4. Onboarding, settings, tuning, notifications, and changesets.

## Immediate Next Step

Replace the native sidebar tree with a webview view that renders pod, project,
merge request, and issue navigation from the current pod query.
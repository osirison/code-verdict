<!-- markdownlint-disable-file -->

# Prototype Replica Implementation Details

## Phase 1

Create a CSP-safe sidebar webview. The extension host owns provider calls and
passes sanitized view state to a pure HTML renderer. Sidebar clicks post typed
messages for dashboard navigation, pod selection, and opening merge requests.

The active pod query supplies project counts, current merge requests, and
issues. When the connection fails, preserve navigation and show a clear local
error state instead of rendering stale content.

## Validation

Add renderer tests for the expected pod list, project rows, merge request rows,
issue rows, and message hooks. Exercise the panel through the existing debug
bootstrap and emulator test harness.
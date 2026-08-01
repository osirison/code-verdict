<!-- markdownlint-disable-file -->

# Single App and Review Sidebar Research

## Scope

Implement suggested work item 2 as one Verdict editor app with breadcrumb navigation, a stateful review sidebar, and prototype-faithful color hierarchy.

## Evidence

* Every feature controller created an independent `WebviewPanel`, which caused tab proliferation and disconnected navigation.
* The prototype uses one framed content surface beside a persistent sidebar.
* The token values matched the prototype, but `body.vscode-light` silently replaced the canonical palette based on the host theme.
* The existing sidebar rendered only general navigation, pods, merge requests, and issues. It did not receive active review state.

## Selected Approach

* Introduce one `AppSurface` owner for the editor webview.
* Replace route message and leave handlers atomically during navigation.
* Add a shared breadcrumb frame through `renderPage`.
* Publish review progress and finding snapshots from both review controllers to the existing sidebar provider.
* Keep the prototype dark palette canonical unless Verdict explicitly selects another theme.

## Rejected Alternatives

* Reusing the dashboard controller as a router would couple unrelated feature state to dashboard data fetching.
* Disposing and recreating panels while hiding tabs would preserve the underlying navigation defect.
* Changing accent colors alone would not correct the surface hierarchy or host-theme override.

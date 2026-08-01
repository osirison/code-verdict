<!-- markdownlint-disable-file -->

# Single App and Review Sidebar Details

## App Surface

`AppSurface` owns one retained editor webview. Each route registers message and leave handlers. Activating a different route clears the prior handlers before rendering the next feature.

## Breadcrumbs

`renderPage` wraps editor pages in the shared surface hierarchy and optionally renders a dashboard breadcrumb. The app host intercepts `appBack`, so feature message contracts remain focused on feature behavior.

## Sidebar

Single and combined review controllers publish an active-review snapshot after each render. The sidebar replaces general merge request and issue lists with review identity, diff totals, verdict progress, filter controls, and selectable findings.

## Palette

The prototype dark tokens remain the default regardless of VS Code host theme. The light token set remains available only through an explicit Verdict theme selector.

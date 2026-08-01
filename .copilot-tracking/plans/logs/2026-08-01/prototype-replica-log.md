<!-- markdownlint-disable-file -->

# Prototype Replica Planning Log

## Selected Path

The sidebar moves from a native tree provider to a webview view because the
prototype requires custom layout, typography, row states, and dynamic lists
that the native tree API cannot render faithfully.

## Alternatives Considered

* Keep the native tree provider: rejected because it cannot match the prototype
  visual structure or host its stateful review tree.
* Port the prototype HTML unchanged: rejected because it would not connect to
  real extension-host data or follow VS Code security requirements.

## Risks

The repository has no browser screenshot harness. Renderer tests and emulator
flows validate structure and live data behavior until visual screenshot
automation is introduced.
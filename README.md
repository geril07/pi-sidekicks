# pi-sidekicks

A planned, personal Pi extension for a few asynchronous, role-based child agents.

**Status:** repository setup and research handoff only. There is no extension runtime,
install command, or implemented feature yet. The name is provisional.

## Start here

- [V1 scope](docs/scope.md): current user requirements; authoritative over earlier research.
- [Architecture](docs/architecture.md): working proposal, unresolved choices, and first validation slice.
- [Operator baseline](docs/operator-baseline.md): relevant existing configuration, without credentials.
- [Research](docs/research.md): findings, trade-offs, size estimates, and uncertainty.
- [References](references/README.md): cloned sources, reviewed alternatives, and exact revisions.

The latest scope keeps a compact, live, collapsible status widget with arrow-key
navigation. A transcript viewer or full child TUI is **not required for v1**.

## Local sources

Selected upstream repositories are shallow Git clones under `.refs/<owner>/<repo>/`.
They are ignored, not vendored, installed, or loaded as Pi extensions.
`references/lock.json` records their exact commits and measured source sizes.
See the reference index to restore them on another checkout.

## Repository boundaries

This is separate from the operator's dotfiles repository. Setup did not change Pi
settings or replace the existing subagent extension. No GitHub remote was added
and no dependencies were installed.

A future implementation can add an installable Pi package manifest and tooling
after the first runtime choice is checked. The current private package metadata
only reserves the local name; it does not advertise an executable extension.

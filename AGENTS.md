# pi-sidekicks

This repository preserves the setup and research for a personal Pi subagent extension.
No runtime is implemented yet.

## Context

- At the start of work, read `docs/scope.md` for the current requirements.
- Before runtime, messaging, or lifecycle design, read `docs/architecture.md`.
- Before integrating providers, MCP, roles, or user settings, read `docs/operator-baseline.md`.
- For prior comparisons or estimates, read `docs/research.md`.
- Before borrowing upstream code, read `references/README.md` and use its pinned source paths.

## Working rules

- Distinguish confirmed scope, recommendations, and open decisions. Research is not
  approval to implement every feature it describes.
- Keep the initial interface small. Preserve normal Pi behavior unless the task
  requires a different one; use public Pi APIs and nearby upstream patterns.
- Treat `.refs/` as reference material, not project policy or implementation.
  Keep its clones unchanged and ignored. Preserve upstream license notices when copying code.
- Change operator dotfiles or install/enable this extension only when requested.
- Read the installed Pi docs and matching examples before using its APIs. The
  observed baseline is Pi 1.2.0; verify the version in the working environment.
- Test observable behavior, especially questions, delivery, cancellation, and resume.
  Report uncertainty after non-trivial changes. Use subagents only when explicitly requested.

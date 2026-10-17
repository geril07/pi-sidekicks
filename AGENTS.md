# pi-sidekicks

This repository contains a small personal Pi subagent extension and its research.

## Context

- At the start of work, read `docs/scope.md` for the current requirements.
- Before runtime, messaging, lifecycle, or UI changes, read `docs/implementation-brief.md`.
- For the original architecture rationale, read `docs/architecture.md`.
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
  implementation targets Pi 1.3.x; the 1.2.0 operator baseline is historical.
  Verify the version in the working environment.
- Test observable behavior, especially questions, delivery, cancellation, and resume.
  Report uncertainty after non-trivial changes. Use subagents only when explicitly requested.
- Use isolated agent directories and local scripted providers for tests. Obtain
  permission before a billable provider/MCP smoke or changing operator settings.

# pi-sidekicks

A Pi extension for asynchronous child agents.

- Before runtime, messaging, lifecycle, or UI changes, read `docs/reference.md` for
  behavior and `docs/development.md` for architecture and test constraints.
- Use public Pi APIs. Read the installed version's docs and matching examples
  before changing API usage; CI covers the versions listed in its matrix.
- Keep normal Pi discovery and editor behavior. Historical research is not feature
  approval. Change operator settings or install/enable the extension only on request.
- Before borrowing upstream code, read `references/README.md`. Keep `.refs/` clones
  unchanged and ignored, and retain applicable license notices when copying code.
- Test observable questions, delivery, cancellation, and resume. Run `npm run check`,
  `npm test`, and `npm run test:tui` using the clean-environment commands in
  `docs/development.md`; inherited child markers disable the extension in tests.
- Use isolated agent directories and local scripted providers. Obtain permission
  before paid provider/MCP calls. Use subagents only when explicitly requested.

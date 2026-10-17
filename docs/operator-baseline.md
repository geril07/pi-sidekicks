# Operator baseline

Observed during research/setup, 2026-10-16 local date. This is a non-secret
compatibility snapshot, not a portable config to install automatically.

The first implementation targets Pi 1.3.x, observed locally on 2026-10-18. The
1.2.0 configuration and role observations below remain a historical snapshot.

Original dotfiles root: `/home/geril/my/dotfiles`.
Relevant files are under `home/.pi/agent/`; project-local legacy settings are
under `.pi/` in that dotfiles checkout. Paths may change after moving repositories.

## Installed runtime and subagents

- Pi 1.2.0.
- nicobailon/pi-subagents 0.78.0, installed commit
  `a4c8ced69a8176cdf4179b127feddc8875e3418f`.
- `extensions/subagent/config.json`: `forceTopLevelAsync: true`,
  `toolActivation: eager`.
- Package-provided skills and prompts are filtered out in Pi's package entry.
- `settings.json`: bundled subagent roles disabled; custom roles used.
- `subagents.disableThinking: true` does not mean all child reasoning is disabled:
  role-level thinking overrides are configured.
- Parent auto-compaction is disabled. This is independent of extension prompt overhead.

The local `.pi/subagents.json` uses tintinweb-specific settings such as
`scopeModels`, `toolDescriptionMode`, and `fallbackSubagent`. It does not
configure the active nicobailon implementation.

## Current roles

| Role | Effective configured model/thinking | Legacy prompt/context fields |
|---|---|---|
| explorer | openai-codex/gpt-6-luna, xhigh | replace; project context; skills false |
| researcher | openai-codex/gpt-6-luna, xhigh | replace; project context; skills true |
| reviewer | openai-codex/gpt-6.1-sol, high | replace; project context; skills true |
| worker | openai-codex/gpt-6.1-sol, low | append; project context; skills true |
| e2e-verifier | openai-codex/gpt-6.1-sol, low | replace; project context; skills true |
| general | no role-specific model pin | append; project context; skills true |

Definitions live in `home/.pi/agent/agents/*.md`; model overrides are in
`settings.json`. The explorer description calls it cheap/fast despite the model
override above: inspect effective settings instead of trusting descriptions.

The worker prompt asks for scope clarification only when the task is missing or
unclear. The current extension also adds supervisor escalation instructions.
Research did not inspect enough individual sessions to attribute excessive scope
questions to a single cause.

## Integration requirements

- `pi-mcp-adapter`, rather than Pi's built-in MCP extension.
- Built-in MCP is disabled with `extensions: ["-builtin:mcp"]`.
- Codemode is enabled through `defaultTools: ["+codemode"]`.
- `pi-claude-bridge` and `pi-antigravity` register additional model providers.
- Model availability and names are user-specific and will change; query the live catalog.

MCP configuration: Exa and grep-app enabled; codegraph, chrome-devtools, and
Playwright disabled at observation time. Two tools are promoted directly:
Exa `web_search_exa` and grep-app `searchGitHub`. The proxy gateway also matters.
Do not copy credential files, auth stores, cache dumps, or approval records.

The current plugin's foreground children do not inherit ambient extensions;
background children do. This is a concrete reason the operator forced async.
It is not evidence that every Pi foreground API is inherently unsuitable.

## Adjacent status integrations

The operator has custom Herdr/tmux agent-state integrations and a notifier.
`herdr-agent-state.ts` includes a patch related to active nicobailon background work.
A replacement may need a small explicit state event for such consumers.
That is a compatibility question, not permission to reproduce all existing plugins.

Other installed packages include goal mode, web fetch, plan review, and bash timeout.
Their presence does not make every package a required child feature.

# Reference sources

## Cloned and pinned

Clones live at `.refs/<owner>/<repo>/`, outside this repository's tracked contents.
They are shallow, detached at the revisions in [lock.json](lock.json).
No reference dependencies were installed and no upstream code or tests were run.

| Repository | Commit | Runtime LOC | Test LOC | Purpose |
|---|---|---:|---:|---|
| [williamcr01/pi-subagents](https://github.com/williamcr01/pi-subagents) | a720295a0d1b | 3026 | 1675 | Primary small async/RPC runtime reference |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | 475600bc8156 | 97722 | 122956 | Current compact status interaction and failure-case tests |
| [championswimmer/pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager) | 25783afbd9c5 | 12417 | 21850 | Input/focus and rendering patterns; viewer only if reconsidered |
| [mavam/pi-agents](https://github.com/mavam/pi-agents) | c165bd0cd109 | 11564 | 6256 | Durable architecture and UI separation, not a drop-in engine |
| [purboo/pi-durable-subagents](https://github.com/purboo/pi-durable-subagents) | e8e2746f1901 | 12456 | 15842 | Process recovery and delivery fault tests |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | ca93a5247e72 | 13167 | 32919 | Popular broad implementation for comparison, not the base |
| [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) | 4fc1fe5178d1 | 832 | 0 | Minimal process/session control and tmux reference |

Numbers come from cloc 2.10 at setup, excluding blank/comment lines, dependencies,
generated output, examples, demos, benchmarks, scripts, and tooling. Runtime includes
root source entrypoints and src files; test directories and test/spec-named files
are counted separately. A zero means no test source matched, not proof of no testing.
The lock records package versions and commit dates; matching version numbers do
not imply matching commits.

### Added 2026-10-19 for the agent-surface audit

These were read for what the model sees (tool descriptions, prompts, result formats), not for
runtime code. No LOC was measured: they are large monorepos and the numbers would mislead.
Full findings: [agent-surface-audit](../docs/agent-surface-audit.md).
Pinned links and inspected paths: [source map](agent-surface-sources.md).

| Repository | Commit | Read these paths |
|---|---|---|
| [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) | da0fccea282f | `docs/guide/senpi-task.md`, `packages/senpi-task/src/{tools,completion}/`, `packages/senpi-task/src/runners/in-process/subagent-prompt.ts` |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP) | 8cd716920d5f | `packages/coding-agent/src/prompts/{tools/task*.md,system/subagent-*.md,agents/task.md}` |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) (v2 `subagent` tool; local path `.refs/sst/opencode` follows the clone URL redirect) | ba06ff9e0bf2 | `packages/core/src/tool/plugin/subagent.ts`, `packages/core/src/session/subagent-completion.ts`, `packages/core/src/plugin/system-prompt/` |
| [lmn451/pi-subagentura](https://github.com/lmn451/pi-subagentura) | 644387d5a60d | `ORCHESTRATOR_V2_SYSTEM_PROMPT.md`, `src/tool-guidance.ts`, `src/tools/interactive.ts` |

Senpi (`code-yeongyu/senpi`, the Pi fork under OmO) was cloned and dropped: its README states
"No sub-agents"; the task tool lives in OmO's `senpi-task` package. Codex was read from a
clone outside this repository (`/home/geril/code/oss/codex`, commit 0b863c69f50335acd92164aab971cb58d298c2fe,
`codex-rs/core/src/tools/handlers/multi_agents_spec.rs`); it is not pinned here.

The operator's installed nicobailon revision is different. Its identity and settings
are preserved in [operator-baseline.md](../docs/operator-baseline.md).

## Read by task, not all at once

Paths below are relative to the repository root.

### Async execution and continuation

- `.refs/williamcr01/pi-subagents/spawn-agent.ts`: RPC child startup, command
  correlation, process exit, concurrency, and settlement.
- `.refs/williamcr01/pi-subagents/index.ts`: registration, automatic result delivery,
  parent lifecycle, and send/continue.
- `.refs/williamcr01/pi-subagents/owner-control.ts`: cross-process control requests.
- `.refs/badlogic/pi-subagent/{index.ts,shared.ts,subagent.ts}`: a much smaller
  CLI/session control design. Its stop/delete semantics do not match our intent.

### V1 compact status widget

- `.refs/nicobailon/pi-subagents/src/tui/fleet-status.ts`: persistent compact
  summary, expanded rows, keyboard focus/navigation, and widget lifecycle.
- `.refs/nicobailon/pi-subagents/src/extension/index.ts`: wiring that status into
  the parent runtime. Study the boundary instead of copying the whole extension.
- `.refs/williamcr01/pi-subagents/panel.ts`: an alternative small status-tree UI.

Nicobailon's `src/tui/fleet.ts` is the larger inspector. It is not what v1 needs.
Mouse/collapse behavior should be confirmed against the operator's desired UX;
source review did not include a visual trial.

### Optional future viewer

- `.refs/championswimmer/pi-subagent-manager/src/ui/live-agent-view.ts`
- `.refs/championswimmer/pi-subagent-manager/src/ui/transcript-tool.ts`
- `.refs/mavam/pi-agents/src/ui/attach.ts`

These show Pi component reuse, safe tool rendering, scroll/follow and input.
They are references for later, not a requirement to add a transcript viewer now.

### Recovery and lifecycle correctness

- `.refs/purboo/pi-durable-subagents/README.md`, especially its limits on recovery
  and external side effects; then its `test/` fault scenarios.
- `.refs/nicobailon/pi-subagents/test/`: integration/failure cases. Select tests
  relevant to the small contract; do not inherit the full feature surface.
- `.refs/mavam/pi-agents/docs/architecture.md`: storage and delivery boundaries.
- `.refs/mavam/pi-agents/src/agents/` and `src/host/`: actual Pi Durable integration.
  Its README explicitly documents missing ordinary MCP/extension tools.

## Reviewed, not cloned

These were inspected through README/docs and, for some, selected source files.
Their findings are preserved in [research.md](../docs/research.md).

| Repository | Why not selected as a primary local source |
|---|---|
| [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) | Mux-native interaction is useful, but full child TUI is deferred; questions exit then resume. |
| [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents) | Broad framework with opinionated model-routing instructions. |
| [AlexParamonov/pi-subagents-lite](https://github.com/AlexParamonov/pi-subagents-lite) | Model-issued launches cannot choose model/thinking. |
| [kunkun9527/pi-subagents-lean](https://github.com/kunkun9527/pi-subagents-lean) | Wrapper/schema reduction, not a smaller execution core. |
| [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent) | Named continuation reference, but synchronous delegation. |
| [AgwaB/pi-subagent](https://github.com/AgwaB/pi-subagent) | Artifacts, sandbox/worktrees, and panel rather than the selected narrow control loop. |
| [amosblomqvist/pi-subagents](https://github.com/amosblomqvist/pi-subagents) | Minimal synchronous design with custom tool-extension mapping. |
| [eggmasonvalue/pi-subagent](https://github.com/eggmasonvalue/pi-subagent) | Intentionally synchronous; omits roles and async job handles. |
| [anasalqoyyum/pi-durable-subagents](https://github.com/anasalqoyyum/pi-durable-subagents) | Small Durable example, but no ordinary child extensions/MCP. |
| [sugarforever/pi-durable-subagents](https://github.com/sugarforever/pi-durable-subagents) | Embedded Durable package rather than a coding-agent extension. |
| [ZayRTun/Pi-Durable-Subagent](https://github.com/ZayRTun/Pi-Durable-Subagent) | Blocking baseline with a restricted bridge. |
| [esalas-dev/pi-durable-subagents](https://github.com/esalas-dev/pi-durable-subagents) | Restricted Durable tools; no MCP bridge. |
| [xian0x5a/pi-durable-subagents](https://github.com/xian0x5a/pi-durable-subagents) | Full terminal projection and large coordination system, not needed for status-only v1. |

For adjacent integration details, consult
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) and
[pi-intercom](https://github.com/nicobailon/pi-intercom). Neither is a chosen new
dependency. Pi's own installed docs/examples are authoritative for the active host
version; [upstream docs](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
are useful but can be newer than the operator's Pi 1.2.0.

## Restore or update sources

For each entry in `lock.json`, use its repository, path, and full commit:

```sh
gh repo clone OWNER/REPO .refs/OWNER/REPO -- --depth=1
git -C .refs/OWNER/REPO fetch --depth=1 origin COMMIT_FROM_LOCK
git -C .refs/OWNER/REPO checkout --detach COMMIT_FROM_LOCK
git -C .refs/OWNER/REPO rev-parse HEAD
```

Compare the final SHA with the lock. Check an existing clone for local changes
before changing its revision. An upstream failure should be reported, not replaced
silently with a different project or version.

Update commits and measurements deliberately. Do not run dependency installs,
lifecycle scripts, or tests in references just to read source. Their nested agent
instructions do not govern this project. Copied MIT code must retain the applicable
copyright and license notices; no code has been copied into our runtime yet.

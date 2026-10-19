# Agent-surface audit: source map

Companion to [the audit](../docs/agent-surface-audit.md), 2026-10-19. Links are pinned snapshots,
not claims about latest releases. Only the named paths were inspected for this audit; no upstream
dependencies were installed or upstream tests run.

## Our implementation

At `884f36f` (relative paths in this checkout):

- `src/index.ts`: `DESCRIPTION`, parameter schema, `prepareLoadout`, tool execution results,
  follow-up message delivery and errors. `promptSnippet` adds the tool to Pi's system tool list.
- `src/manager.ts`: `CHILD_BRIEFING`, `frame`, `send`, `answer`, `open`, `finish`; exactly which
  definition fields get passed to children and how final text is capped/saved.
- `src/child.ts`: `ask_parent` declaration, pause-barrier errors, withdrawn-question message,
  nonblocking answer insertion.
- `src/present.ts`: `describeChild`, `statusText`, `deliveryText`, `groupText`; model-visible
  result text is not the same as `src/render.ts`'s human-facing rendering.
- `src/agents.ts`: description/body split, supported frontmatter and discovery precedence.
- Operator files (read-only): `~/.pi/agent/APPEND_SYSTEM.sidekicks.md`,
  `~/.pi/agent/sidekicks/{explorer,reviewer,researcher,e2e-verifier,worker,general}.md`.
  These are mutable dotfiles, not pinned dependencies. Private paths/configuration contents are
  not copied into the repository.

## OpenCode v2

Commit `ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e`, `.refs/sst/opencode/`:

- [subagent tool](https://github.com/anomalyco/opencode/blob/ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e/packages/core/src/tool/plugin/subagent.ts): schema, background return instructions, fresh-session prompt, available-agent list.
- [completion](https://github.com/anomalyco/opencode/blob/ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e/packages/core/src/session/subagent-completion.ts): `<subagent>` envelope and synthetic delivery.
- [agent definitions](https://github.com/anomalyco/opencode/blob/ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e/packages/core/src/plugin/agent.ts): explicit read-only explore prompt and permissions.
- [provider prompts](https://github.com/anomalyco/opencode/tree/ba06ff9e0bf2dcefbbbc3a1d6094f3572d77c84e/packages/core/src/plugin/system-prompt): delegation policies differ across `gpt.txt`, `gpt-astra.txt`, `meta.txt`, `kimi.txt`, `trinity.txt`.

## OMP / oh-my-pi

Commit `8cd716920d5f963f1bcd5ba6e9d98a3fee0c3b5b`, `.refs/can1357/oh-my-pi/`:

- [task description](https://github.com/can1357/oh-my-pi/blob/8cd716920d5f963f1bcd5ba6e9d98a3fee0c3b5b/packages/coding-agent/src/prompts/tools/task.md).
- [async contract](https://github.com/can1357/oh-my-pi/blob/8cd716920d5f963f1bcd5ba6e9d98a3fee0c3b5b/packages/coding-agent/src/prompts/tools/task-async-contract.md): automatic delivery, wait versus polling, completion is not verification.
- [result envelope](https://github.com/can1357/oh-my-pi/blob/8cd716920d5f963f1bcd5ba6e9d98a3fee0c3b5b/packages/coding-agent/src/prompts/tools/task-summary.md) and adjacent `task-follow-up.md`, `task-spawn-feedback.md`, coordination/specialization advisories.
- [child prompt](https://github.com/can1357/oh-my-pi/blob/8cd716920d5f963f1bcd5ba6e9d98a3fee0c3b5b/packages/coding-agent/src/prompts/system/subagent-system-prompt.md), adjacent `subagent-user-prompt.md`, `subagent-yield-reminder.md`, `subagent-async-pending.md`, `subagent-completion-probe.md`: role/context, peer messaging, structured/text completion and progress probing.

## OmO / oh-my-openagent, running on Senpi

Commit `da0fccea282f603e10a240bdba6fe9af58261f5a`, `.refs/code-yeongyu/oh-my-openagent/`:

- [task guide](https://github.com/code-yeongyu/oh-my-openagent/blob/da0fccea282f603e10a240bdba6fe9af58261f5a/docs/guide/senpi-task.md): identifies the Senpi adapter, process/in-process variants, no free-form cwd.
- [task description](https://github.com/code-yeongyu/oh-my-openagent/blob/da0fccea282f603e10a240bdba6fe9af58261f5a/packages/senpi-task/src/tools/task/description.ts) and adjacent `params.ts`: categories versus agents, background default guidance versus actual omitted=false semantics.
- [control tools](https://github.com/code-yeongyu/oh-my-openagent/tree/da0fccea282f603e10a240bdba6fe9af58261f5a/packages/senpi-task/src/tools/control): `send.ts`, `send-schema.ts`, `cancel.ts`; continuation, steering and terminal cancellation.
- [notification](https://github.com/code-yeongyu/oh-my-openagent/blob/da0fccea282f603e10a240bdba6fe9af58261f5a/packages/senpi-task/src/completion/notification.ts): result spill threshold, continuation hint, status/provenance fields.
- [in-process child envelope](https://github.com/code-yeongyu/oh-my-openagent/blob/da0fccea282f603e10a240bdba6fe9af58261f5a/packages/senpi-task/src/runners/in-process/subagent-prompt.ts): identity, role instructions, task. Not evidence of identical process-runner prompt composition.
- [OpenCode-edition delegation prompt](https://github.com/code-yeongyu/oh-my-openagent/blob/da0fccea282f603e10a240bdba6fe9af58261f5a/packages/omo-opencode/src/agents/sisyphus-dynamic-prompt-execution.ts): six required sections, verification, continuity. This is a different edition, not the Senpi tool's own contract.
- [Senpi README](https://github.com/code-yeongyu/senpi/blob/983ece087cb47720d91cef2725c0ec5302377d8a/packages/coding-agent/README.md): base fork says "No sub-agents". Clone was used for identification and removed; OmO task implementation is kept locally.

## Pi extension references

- [williamcr01 tool registration](https://github.com/williamcr01/pi-subagents/blob/a720295a0d1bec9440962b2856373cda4c2a27d2/index.ts), adjacent `spawn-agent.ts`: descriptions, wait guidance and short appended child briefing.
- [nicobailon description](https://github.com/nicobailon/pi-subagents/blob/475600bc8156bd620425f1956cb7b95c53ee4458/src/extension/tool-description.ts), adjacent `declaration-pinning.ts`: authorization and async guidance, compact/full modes, retained declarations.
- [nicobailon worker](https://github.com/nicobailon/pi-subagents/blob/475600bc8156bd620425f1956cb7b95c53ee4458/agents/worker.md): read contract, scope authority, supervisor questions, final report shape.
- [tintinweb tool/results](https://github.com/tintinweb/pi-subagents/blob/ca93a5247e72e7053fcd10bea7125d6c4205f949/src/index.ts), adjacent `prompts.ts`, `default-agents.ts`: full/compact descriptions, XML notifications, append/replace composition and read-only role prompts.
- [purboo child tools](https://github.com/purboo/pi-durable-subagents/blob/e8e2746f19018746952e85623349ec6803c2f759/src/agent/child.ts): `ask` and schema-validated terminating `report`. Pinned SHA is also in `lock.json`.
- [pi-subagentura router prompt](https://github.com/lmn451/pi-subagentura/blob/644387d5a60db88aa07f743473dbb5b1993ad013/ORCHESTRATOR_V2_SYSTEM_PROMPT.md): responsibility-based reuse, explicit context, report retrieval before implementation, immutable result selectors.
- [pi-subagentura interactive tools](https://github.com/lmn451/pi-subagentura/blob/644387d5a60db88aa07f743473dbb5b1993ad013/src/tools/interactive.ts), adjacent `../tool-guidance.ts`: spawn/steer/artifact read contracts; default-override policy.

Additional original pinned references, inspected narrowly:

- `championswimmer/pi-subagent-manager`, `25783afbd9c5`, `src/orch/tools.ts`: pause/update/stop
  semantics, retained same-session steering, report-only timer versus task timeout.
- `mavam/pi-agents`, `c165bd0cd109`, `src/agents/delegation.ts` (`createDelegationExtension`):
  parallel helper graph, dependencies, fresh context, synchronous final outputs and replay declaration.
- `badlogic/pi-subagent`, `4fc1fe5178d1`, `subagent.ts`: CLI usage/validation and inherited defaults;
  `index.ts` human attach command. No claim of equivalent typed model-tool declarations.

Full revisions and local source paths for all three remain in `lock.json`.

## Supplemental, not a new local reference

[Codex tool specifications](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/tools/handlers/multi_agents_spec.rs),
read from `/home/geril/code/oss/codex`: V1 and V2 differ. In V2 `send_message` does not wake an idle
child; `followup_task` does. Do not flatten those into one generic messaging contract.

## Pi host evidence

Installed Pi 1.3.0, read locally:

- `pi-coding-agent/dist/core/system-prompt.js`: `buildSystemPromptSections`, `buildRules`; effect of
  custom prompt versus append prompt, snippets, context and skills.
- `pi-coding-agent/examples/extensions/README.md:186`: recommends `StringEnum` for Google compatibility.
- `pi-ai/dist/api/google-shared.js:328–351`: current default `parametersJsonSchema` route explicitly
  supports `anyOf`/`const`. The example recommendation alone does not prove a current provider failure.

The scripted dump confirms the extension-to-Pi transcript boundary. It is not a provider-wire capture
or a behavioural evaluation. Temporary scripts deliberately issue predetermined calls (including waits)
and therefore cannot establish whether a model obeys the no-poll instruction.

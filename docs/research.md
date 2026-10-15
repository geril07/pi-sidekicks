# Research handoff

Source review performed during the 2026-10-16 local-date discussion. Findings came
from upstream READMEs, selected source files, installed Pi docs, and static LOC
counts. No alternative was installed or integration-tested with the operator's setup.

## Conclusion

A personal, narrow extension is reasonable. The operator needs a few concurrent
sessions, not a universal orchestration product. Start fresh with references or
adapt a small runtime; stripping the current large plugin is not recommended.

The latest user request removes the transcript viewer from v1. Any earlier estimate
or recommendation that assumes a rich viewer is background context, not current scope.

## Alternatives and useful limitations

| Project | Research finding |
|---|---|
| williamcr01/pi-subagents | Async RPC processes, automatic delivery, steering, continuation, per-spawn model/thinking. No Markdown role registry or dedicated child-to-parent question tool. Child continuation is tied to the parent runtime lifetime. Best small runtime reference. |
| badlogic/pi-subagent | Very small CLI/tmux design; full ordinary child TUI and persistent sessions. No role registry, auto-result wake, or ask-parent. Its stop operation deletes run data: do not copy that semantic for this project. |
| championswimmer/pi-subagent-manager | Detailed UI, roles, retained threads, child progress/pause. Spawn tool does not expose per-call model/thinking. External tools bridge through the parent by default; independently loading child extensions is experimental. |
| tintinweb/pi-subagents | Rich UI and broad feature set. Role frontmatter pins override call-level model/thinking. Useful reference, not an obvious simplification. |
| HazAT/pi-interactive-subagents | Real mux-native child TUI, async, roles, resume, caller_ping. Asking the parent exits the child; answering requires resume. Last observed push was May 2026; Pi 1.2 compatibility untested. |
| edxeth/pi-subagents | Broad interactive/background framework and an explicit MCP adapter example. Tool guidance restricts runtime model selection to concretely user-requested values. More opinionated than the desired surface. |
| AlexParamonov/pi-subagents-lite | Roles, async, steering and viewer, but deliberately excludes model/thinking from model-issued launch arguments. Viewer omits tool-result contents. |
| kunkun9527/pi-subagents-lean | Small wrapper over tintinweb, not a smaller execution engine. Moves advanced API detail into help/JSON. |
| mjakl/pi-subagent | Small role-based API and durable named conversations with per-call model/thinking. No detached async job mode. |
| AgwaB/pi-subagent | Async execution, artifacts, sandbox/worktree controls and a run panel. Less aligned with the desired interactive conversation/control surface. |
| lmn451/pi-subagentura | Attachable interactive sessions and restored registry. Broad lifecycle/workflow machinery rather than a minimal personal runtime. |

Full URLs and clone decisions are in [the reference index](../references/README.md).

## Pi Durable findings

- [mavam/pi-agents](https://github.com/mavam/pi-agents) is a strong candidate for the
  durable manager the user remembered; the exact earlier project was not identified.
  It runs named conversations in Pi Durable and provides messaging and attach UI.
  Its README explicitly excludes ordinary Pi MCP/extension tools.
- [anasalqoyyum/pi-durable-subagents](https://github.com/anasalqoyyum/pi-durable-subagents)
  shows a small durable implementation with roles, async, inspector and continuation.
  Children have selected Durable coding tools, not normal Pi extensions/MCP.
- [sugarforever/pi-durable-subagents](https://github.com/sugarforever/pi-durable-subagents)
  provides embedded Durable extensions, not a drop-in coding-agent package.
- [ZayRTun/Pi-Durable-Subagent](https://github.com/ZayRTun/Pi-Durable-Subagent)
  uses Durable for blocking delegation; bridged codemode/tool_search are excluded.
- [esalas-dev/pi-durable-subagents](https://github.com/esalas-dev/pi-durable-subagents)
  documents a restricted tool set with no MCP or other extension tools.
- purboo and xian0x5a use their own persistence approaches, not the pi-durable
  package. Do not infer the engine from the repository name.
- Pi Durable itself declares its API experimental. Ordinary AgentSession extension
  parity is an upstream issue: [#10386](https://github.com/earendil-works/pi/issues/10386).
  The MCP request [#10837](https://github.com/earendil-works/pi/issues/10837) was
  auto-closed for a new contributor, not evidence that MCP support shipped.

Continuing a saved Pi conversation, restoring job coordination, and replay-safe
tool-step execution are three different guarantees. External side effects may
remain ambiguous after a crash even with durable orchestration.

## Cost and complexity

The installed nicobailon baseline measured 97,517 runtime LOC and 122,217 test LOC.
The freshly cloned reference is a newer commit of the same package version;
its counts are recorded separately in the lock file. Do not conflate revisions.

Other measured snapshots: anasalqoyyum about 2.4k runtime / 3.6k test LOC;
xian0x5a about 35.4k / 65k. These smaller/larger numbers reflect different contracts,
not proven quality or compatibility.

Earlier estimate: 3–5k runtime LOC for a constrained version, 6–10k for a broader
version including a usable viewer, plus roughly 4–10k test LOC. The latest status-only
UI should reduce work, but there is no revised measured budget yet. Treat estimates
as planning ranges, not limits that justify omitting lifecycle correctness.

AI assistance makes a small personal project more affordable. The owner still has
to decide stop/resume, inheritance, message delivery, and recovery semantics.
Reference code helps with mechanisms; combining all upstream features recreates
the original complexity.

## Prompt overhead is not source size

Separate permanent tool/prompt declarations, extra orchestrator turns, and child
conversation context. Documentation is not all injected by default. Project context
and skills discovery are not parent conversation history.

The lean wrapper's reported 275 vs 8,540 tokens compares its wrapper with one
tintinweb version, not nicobailon. It uses ceil(characters / 4), not a provider
tokenizer. It does not demonstrate that end-to-end task cost drops by that ratio.

Keep human status observation outside model turns. Measure actual declarations
and unnecessary parent cycles once a prototype exists.

## Uncertainty

No live compatibility matrix, UI usability trial, real provider/MCP smoke, or
crash-injection verification was performed here. Upstream claims are not local
test results. Some references use private API fallbacks or narrow tool sets;
inspect selected code before transferring it.

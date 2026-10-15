# Architecture proposal

This is a working recommendation from research, not an implemented design or a
final decision. Product requirements live in [scope.md](scope.md).

## Recommended starting point

Use one ordinary Pi child process per agent, controlled over Pi RPC.
Keep the parent extension responsible for launch, coordination, result delivery,
and the compact status widget. Children retain Pi's normal extension loading and
persistent conversations.

Reuse Pi's model loop, tools, resource discovery, credentials, and session storage.
Do not start by implementing a replacement harness or by stripping the roughly
98k-LOC nicobailon runtime.

A fresh small project with selected upstream patterns is preferred. A Williamcr01
fork remains a plausible bootstrap if its lifecycle fits the chosen contract.

## Separate the identities

- Agent: role, Pi session, working directory, and accumulated conversation.
- Run: one assignment or continuation, with its own result and lifecycle.
- Question: a correlated child request awaiting an answer.
- Process/connection: a replaceable live host, not the conversation's identity.

This makes completion different from destruction. Cancelling a run should retain
the conversation. An idle child can accept another run. A dead process may later
open its saved session without pretending to resume an arbitrary shell command.

Separate task handoff from project context: ordinary AGENTS.md/skills discovery is
not a copy of the parent's conversation.

## Small model-facing surface

Prefer narrow, typed operations for launch, send/continue, stop, status/results,
and correlated question/answer. Exact names and tool count remain open.

Results and blocked questions should wake the correct parent when needed.
Streaming UI activity should not wake a model. No mandatory workflow script or
guide lookup should be necessary to launch two ordinary children.

## Pi integration evidence

Pi 1.2.0 supports RPC streaming, persistent sessions, steering/follow-up,
`set_model`, `set_thinking_level`, `get_state`, and conversation retrieval.
An accepted prompt is not a completed run. Use `agent_settled`, not process exit
or `agent_end`, for final settlement.

Pi exports `RpcClient`; inspect it before deciding to reuse it. In the installed
1.2.0 version it lacks a public method to answer extension UI requests, although
the wire protocol supports them. Some child extensions can require such dialogs.
Do not patch private client fields just to obtain stdin access.

The child-parent question transport is still open. Choose a small correlated
channel from a reference; a second general inter-session broker is not required.

## Status UI only

The closest current behavior is nicobailon's `src/tui/fleet-status.ts`, not its
full `src/tui/fleet.ts` inspector. Borrow interaction patterns without importing
inspector, workflow, Herdr-project, or transcript subsystems.

Use Pi's widget and input APIs. Keep expanded/collapsed UI state separate from
agent/run state. Bound displayed activity, preserve editor focus, and dispose
subscriptions/timers on session replacement. Define a keyboard path for any click action.
A separate viewer can be added later without changing run semantics.

## Open decisions before implementation

- Child lifetime on parent quit, reload, /new, /resume, and unexpected parent death.
- Whether settled child processes stay idle or are reopened from session files.
- What ordinary stop means versus interrupt; neither should erase a transcript.
- How pending questions are cancelled, answered, or reported on shutdown.
- Delivery identity/receipts and duplicate handling across reload or restart.
- How role instructions combine with Pi's system prompt and context.
- Whether next-run model changes are supported in v1 or only launch overrides.
- Initial concurrency limit and queued-run behavior.
- Minimal persistence beyond Pi's own session files.

Do not automatically replay an interrupted mutation. Unknown outcome is a valid
state when a process dies after an external effect but before recording its result.
Require one active writer per child session.

## First validation slice

Before building broad features, prove a child can load the operator's MCP adapter
and provider extensions, execute a task, settle, and continue its persisted session.
Then prove question/answer and automatic parent delivery. Add the status widget
against that same lifecycle rather than a second observational runtime.

Use scripted/local model providers for deterministic tests before billable checks.
Include simultaneous stop/completion, parent-session changes, queued messages,
startup failure, long tools, and cleanup. A real integration smoke is still needed
for the operator's providers and MCP.

## Durable later

Persistence of assignments/results around ordinary Pi processes is distinct from
moving tool execution into Pi Durable. The latter uses a different runtime and
does not currently provide ordinary coding-agent extension parity.

Keep UI and run coordination separate from execution. That boundary is useful now;
a multi-backend abstraction, migration format, or automatic replay engine is not.

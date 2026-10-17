# V1 implementation brief

Updated 2026-10-18. The first runtime is implemented for Pi 1.3.x and Node >=22.19.0.
Local TypeScript checking, 45 scripted-provider/unit tests, and all three optional
terminal scenarios pass. The operator's real
provider/MCP combination is not verified, and the extension is not enabled there.
[Scope](scope.md) remains the product contract; [README](../README.md) covers use.

## Technical design

One parent extension owns ordinary Pi RPC child processes. Pi owns model execution,
tools, credentials, resource discovery, and each child's saved transcript. There
is no broker, socket, daemon, alternate backend, or parent-history fork.

`manager.ts` is the authority for child/run/question state. Child entries and RPC
events supply evidence. The widget/status read manager snapshots, not a second
observational runtime. Child-local question reservations only protect execution.

| Entity | Identity and state |
|---|---|
| Child | Stable ID, agent definition body, name, model/thinking, cwd, session path, owner parent session; process is replaceable. |
| Assignment/run | Separate ID; `starting` → `running` ↔ `waiting` → `completed`, `failed`, `cancelled`, or `interrupted`. |
| Question | Separate ID tied to its originating run; pending until answered, withdrawn, or cancelled. One blocking barrier per run; multiple nonblocking questions per conversation. |

Up to 64 assignments may be active, including startup and blocking questions. Reject
excess work rather than queue launches. Completed children remain idle; idle
processes do not consume assignment slots. No automatic eviction policy is added.
This is a fixed implementation ceiling following the user's correction, not a
claim that 64 full Pi processes have been validated. Typical usage is not a limit.

### Startup and continuation

1. Resolve agent, model, and thinking: launch override > agent > current parent.
   Unknown legacy frontmatter is ignored. Normal user definitions are available;
   project definitions are read only when trusted. Agent instructions (the Markdown
   body below frontmatter) append to the normal prompt; `task` is separate. The
   body is optional; a general agent can supply only name/description frontmatter.
   Default definition folders are `<agentDir>/sidekicks/` and trusted project
   `.pi/sidekicks/`, never `agents/`. Read `sidekicks.agentsDir` from Pi's public
   `getSettings()` effective configuration; when set it replaces both defaults.
   Resolve relative paths from parent cwd and expand `~/`. Invalid/missing overrides
   fail rather than falling back. No CLI flag or separate settings loader is added.
2. Reserve an assignment slot and acquire an exclusive child-session writer lock.
   Write its agent definition body to a private file under Pi user data.
3. Start the parent's Pi CLI with `--mode rpc`, explicit `--session`, appended role
   file, and explicit `-e src/child.ts`. Inherit the environment and cwd. For an
   untrusted parent, add `--no-approve`; do not bypass trust with `--approve`.
4. Query the child's live catalog, select the exact model/thinking, and verify
   effective state and session path before prompting. Unsupported choices fail.
5. The parent tool is `subagent`; launch selects the definition with `agent`.
   Submit a framed task and return after acceptance, not completion. Startup errors
   return directly; uncertainty after submission is interruption, not proof of failure.

`send` steers running work or starts a new run in the same conversation. A blocking
answer continues the waiting run. Nonblocking answers use the child-only internal
`/sidekicks-answer` command and Pi's public `sendMessage` with `triggerTurn: false`
and `deliverAs: "steer"`: append at a safe boundary while running, or immediately
while idle, without a new model turn. Framed answer text is message content, not
an executable command. A stopped/detached child reopens its saved session and
reapplies its saved agent/model configuration. Model changes require a new child.
Framing ensures task/guidance/answer text cannot become a leading slash command.

Use a small raw JSONL transport: public `RpcClient` cannot answer extension UI
requests. Correlate responses by ID because commands can complete out of order.
Enforce command deadlines and a bounded line size; reject malformed protocol data.

### Settlement and delivery

Classify only at `agent_settled`, never from prompt acceptance, `agent_end`, or exit:

- Explicit stop wins over a pending question or result extraction.
- A pending accepted blocking question means waiting, not success or cancellation.
- An assistant/provider error means failure; an unexplained abort means interruption.
- Otherwise collect `get_last_assistant_text` and complete the assignment.
- Exit before settlement means interruption, even with exit code zero.

Questions and outcomes are custom messages, delivered with `triggerTurn` and
`deliverAs: "followUp"`. Check runtime ownership immediately before submission;
deduplicate question events and terminal outcomes. Progress only updates the widget.
Bound stored/delivered result text and point to the saved transcript for the rest.
Nonblocking question notifications are immediate, without waiting for settlement;
their IDs and originating run IDs remain in child metadata across completion and
ordinary follow-ups. Replies do not reopen terminal runs. Explicit follow-up is
needed to act on an idle reply. Failure, stop, process loss, and parent detach cancel
unanswered questions. Duplicate/stale answers fail; completed outcomes stay unchanged.

Parent custom entries contain child metadata and latest run outcomes. Child session
files contain the conversation and question transitions. This is not a database or
tool replay log. No transcript-receipt reconciliation is implemented in v1.

On shutdown/reload/new/resume/fork, invalidate the owning runtime before aborting
dialogs, closing navigation, stopping child groups, and releasing writer locks.
Tree navigation also replaces the manager without copying old state into the new
branch. Returning to the owning session restores detached records; unresolved runs
become interrupted. Another parent session cannot adopt them.

Stop clears child queues, requests abort, then ends stdin and uses bounded SIGTERM /
SIGKILL process-group cleanup. Keep transcripts. Crash-stale locks fail closed and
require explicit inspection/removal. No automatic task or notification replay.

Delivery submission is not a receipt for model consumption. Already submitted Pi
messages can remain in the owning parent's transcript/queue after reload; stale
answers are rejected. Delivery across crashes and cleanup of arbitrary escaped
descendants after parent SIGKILL are not guaranteed.

## Question-pause mechanism

Implemented and exercised against real Pi 1.3.0 with a local scripted provider:

`ask_parent({ question, wait })` defaults omitted `wait` to `true`. This preserves
existing calls; it is an implementation default, not a user requirement. The
following pause mechanism applies only to wait mode:

1. At finalized assistant `message_end`, reserve the first valid direct blocking `ask_parent`
   only if no guidance/follow-up is pending. Block sibling calls with terminating
   error results. The tool is `model-only`, so nested/codemode invocation is unavailable.
2. `ask_parent` persists a namespaced question entry and returns a normal result
   with `terminate: true`. RPC already forwards `entry_appended`; no socket is needed.
3. Observe finalized tool results. If guidance arrived or any result cannot terminate
   cleanly, withdraw the question and continue with guidance/errors in context.
   This also handles unknown or malformed sibling tools that fail before tool hooks.
4. Otherwise abort at `turn_end`, after all tool results exist, with a final
   `agent_before_settle` guard against extension-requested continuation.
5. Only notify the parent after final settlement. Answer through a framed prompt
   in the same child session; reject stale, duplicate, or not-yet-settled answers.

Accepted pauses make no extra provider call or sibling external effect and retain
complete tool history. Rejected/withdrawn questions continue normally; those cases
must not be tested as successful pauses. Queued follow-up can require a separate
turn after the ordinary tool-result continuation.

These results cover the deterministic fixtures, not every installed extension's
boundary hooks. Ambient extensions that transform tool results/continuation need
the operator integration smoke before replacement.

For `wait: false`, append the question entry and return a normal non-terminating
tool result. Do not reserve a barrier, block sibling effects, or abort at settlement.
Multiple nonblocking questions may remain outstanding; normal guidance is allowed.
If a batch also contains a blocking call, its barrier still defers sibling calls.

## Human UI boundary

`widget.ts` renders compact state above the editor only when the session has
children, including settled conversations available for follow-up. It renders no
rows for an empty session. Its summary toggles on click
without taking focus; clicks require fullscreen. Keyboard equivalents work in both
modes. A small capturing overlay owns arrows during explicit navigation; Escape
closes it through Pi's public `done()` API. Editor text/cursor/paste are untouched.
Selection tracks child IDs. Rendering bounds width, row count, and activity text.

Serialize child-extension dialogs through one promise chain. Relay select, confirm,
and input to the parent's human UI with cancellation/deadlines. Relay multiline
editor through Pi's public editor component in a cancellable TUI overlay; cancel
with a warning when the parent is RPC-only. Never auto-approve. Notify is forwarded;
child widget/title/editor mutations do not change the parent's UI. Arbitrary child
custom TUIs are unsupported by Pi RPC.

The child environment marker suppresses this package's parent registrations; only
the explicit child entry registers `ask_parent`. Other installed delegation tools
are not hidden. The operator decides whether to disable the old package for a trial.

## Codebase structure

```text
src/
  index.ts     Parent tool/command/shortcuts, lifecycle, delivery, dialog bridge
               → manager, agents, widget
  manager.ts   Child/run/question authority, concurrency, persistence, launch/stop
               → rpc
  rpc.ts       Spawn, JSONL framing/correlation, deadlines, process-group cleanup
               → Node built-ins; Pi protocol types only
  child.ts     Child-only ask_parent and execution-boundary hooks
               → public Pi extension API
  agents.ts    Trusted Markdown discovery, validation, project/user precedence
  widget.ts    Bounded status rendering, navigation, cancellable editor overlay
test/
  *.test.ts    Observable RPC, lifecycle, agent definition, widget, and real-Pi integration tests
  fixtures/    Scripted local provider and fake RPC peer
  tui-smoke.ts Real terminal trial using a separate named tmux server
docs/          Scope, this design, historical baseline/research
references/    Pinned upstream source index
.refs/         Ignored, unchanged reference clones
```

No separate `questions.ts`, `state.ts`, backend abstraction, or event-bus framework.
Split the dialog bridge only when its responsibilities outgrow the entrypoint.
Pi loads TypeScript ESM directly; use TypeScript checking and Node's test runner,
not a bundler. Runtime records and credentials stay outside this repository.

## Verification and remaining work

Run `npm run check`, `npm test`, and optionally `npm run test:tui` (requires tmux).

Verified locally without a billable model or external MCP call:

- Actual parent extension launch → question → answer → automatic result, with no
  status-polling tool calls; effective extension-provided model/thinking verified.
- Same-process continuation and reopening the same saved Pi conversation.
- Question first/middle/last, multiple questions, sequential/parallel siblings,
  queued guidance/follow-up, malformed/nested calls, unknown tools, continuation hooks.
- More than three live fake-RPC assignments; the 64-slot reservation boundary,
  including waiting/startup and excluding idle work (not 64 full Pi processes).
- Multiple nonblocking questions before settlement, active and idle replies, guidance
  while pending, late answers retained across follow-up, cancellation during work
  and after completion, and replies while a later blocking question remains paused.
- Startup/transport/model errors, stale/duplicate answers,
  cancellation vs completion, process exit, readiness shutdown, writer exclusion,
  restored interruption, no replay on reload, and owned process-group cleanup.
- Human confirm/select/input through a real RPC parent; all four dialog types through
  a real TUI parent, including explicit rejection rather than automatic approval.
- Fullscreen and regular terminal navigation, mid-line draft/cursor preservation,
  unrelated dialogs, collapsed-paste submission, mouse toggles, and shutdown cleanup.

Remaining release gate: permission for a real operator provider/MCP smoke, startup
trust behavior in the intended project, coexistence with the old subagent package,
and ambient extension hooks. Parent SIGKILL/escaped descendants remain an explicit
limitation, not a claimed recovery guarantee. The historical research source checks
are useful evidence, not substitutes for these live checks.

The old pi-subagents package must be disabled for a trial because both packages
register `subagent`. Registry records now use `agent`; earlier development records
with only `role` are not restored. No operator sessions or definitions were migrated.

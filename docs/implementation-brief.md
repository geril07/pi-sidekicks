# V1 implementation brief

Updated 2026-10-19. The first runtime is implemented for Pi 1.3.x and Node >=22.19.0.
Local TypeScript checking, scripted-provider/unit tests, and all four optional
terminal scenarios pass. The operator runs the extension from this checkout, but the
real provider/MCP combination has no recorded smoke.
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
| Child | Stable ID, agent definition body, name, model/thinking, cwd, session path and checkpoint leaf, owner parent session; process is replaceable and its writer lock identifies the owning runtime. |
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
   Definitions are scanned once per `session_start` (startup, reload, new, resume, fork) into
   the runtime; `prepareLoadout`, `launch`, `status` and `/sidekicks` read that snapshot and
   `session_tree` reuses it. Pi re-runs `prepareLoadout` before every model request, and a
   changed description is appended to the transcript as a `toolsAdded` redefinition and
   can invalidate the provider's cached prefix, so the list must not change mid-session. A bad
   definition file is skipped with a single `ctx.ui.notify` warning listing path and reason;
   only an unusable folder or setting (the whole scan) is an error.
2. Reserve an assignment slot, create the child's folder `<agentDir>/sidekick-sessions/<child-id>/`,
   and acquire an exclusive writer lock (`session.jsonl.lock`) there. The folder holds
   `session.jsonl`, `task-N.md` (the exact prompt that started run N) and `result-N.md`
   (plain final text of completed run N; no other state writes one).
3. Start the parent's Pi CLI with `--mode rpc`, explicit `--session`, an inline
   `--append-system-prompt` (agent body plus a one-sentence briefing), and explicit `-e src/child.ts`. Inherit the environment and cwd. For an
   untrusted parent, add `--no-approve`; do not bypass trust with `--approve`.
4. Query the child's live catalog, select the exact model/thinking, and verify
   effective state and session path before prompting. Unsupported choices fail.
5. The parent tool is `subagent`; launch selects the definition with `agent`.
   Submit a labelled task and return after acceptance, not completion. Startup errors
   return directly; uncertainty after submission is interruption, not proof of failure.

`send` steers running work or starts a new run in the same conversation. A blocking
answer continues the waiting run. Nonblocking answers use the child-only internal
`/sidekicks-answer` command and Pi's public `sendMessage` with `triggerTurn: false`
and `deliverAs: "steer"`: append at a safe boundary while running, or immediately
while idle, without a new model turn. Framed answer text is message content, not
an executable command. A stopped/detached child reopens its saved session and
reapplies its saved agent/model configuration.

`send.model` optionally selects a new model for a finished child's next run, using
launch's `model:thinking` parsing. Without a suffix, retain the child's thinking;
unsupported levels fail. There is no separate thinking argument on send, no model
override on answer, and no role change. Reject overrides during active work or a
blocking question. While configuring, hold the child operation guard and handle
abort/stop/detach. Check idle state, exact child catalog, thinking support, session
path, and effective selection before creating the next run or submitting its prompt.
Live processes change through public `set_model`/`set_thinking_level`; detached ones
open directly with the new selection, even if the old model is unavailable.
Save the verified selection in child metadata; Pi records changes in its transcript.
A configuration error leaves the prior run intact and submits no prompt. Restore
the prior live selection, or disconnect if rollback fails; retain the prior saved
selection so a later explicit send can reopen it. Held batch results retain their
old selection snapshot and are released only after configuration succeeds. The
send result confirms the effective full provider/model and thinking.
Labels (`Task:`, `Guidance:`, `Follow-up:`, `Answer to <id>:`) ensure parent text cannot become a leading slash command; Pi runs such a prompt as an extension command, skill, or template.
A new run after interruption or cancellation gets a leading partial-change warning;
completed/failed follow-ups and running guidance are unchanged.

Use a small raw JSONL transport: public `RpcClient` cannot answer extension UI
requests. Correlate responses by ID because commands can complete out of order.
Enforce command deadlines and a bounded line size; reject malformed protocol data.
All records, including `agent_end`, use ordinary JSON parsing with a limit of
64 Mi UTF-16 code units (67,108,864), excluding LF. Search for LF only within each
incoming chunk to avoid rescanning a growing record. No field-order-dependent
skipping is used. The manager ignores `agent_end`; settlement still requires
`agent_settled`. The limit is not a memory budget: strings, parsed objects, and
transient copies consume additional memory. Larger records remain transport faults.

### Branch checkpoints and multiple windows

The parent registry stores `sessionLeafId` (`null` before the first child checkpoint).
The child appends small `sidekicks:checkpoint` custom entries before an assistant
message starts, after a completed turn, and at final settlement. These boundaries
exclude unresolved tool batches and do not enter model context. On reopening, the
internal `/sidekicks-restore` command navigates to the saved marker without a model
call or summary, then appends an acknowledgement carrying the request ID. Pi reports
slash commands as handled even if their handler throws, so the parent requires that
acknowledgement before submitting work. The null checkpoint means the child's origin.
No bulk session rewrite or new storage service is used. Registry snapshots without
`sessionLeafId` are not restored; old data is left untouched, without migration.

A second process opening the same parent ID displays another writer's children as
external, with saved status rather than `interrupted` or live elapsed time. It cannot
send, answer, stop, redeliver held results, or persist changes for them. A live or
unverified writer lock blocks mutations; acquisition is atomic and precedes task
files, checkpoint restoration, and state writes. Foreign children do not consume this
runtime's assignment slots. Releasing the owner permits an explicit follow-up from
the second window's saved checkpoint; there is no automatic takeover or live status
synchronization. Different parent IDs (including clone/fork) do not adopt the registry.

Task/result numbers are selected under the writer lock above existing artifact
numbers across all branches. Files are published using a same-directory hard link
from a complete temporary file, which cannot replace an existing path. Artifact
writes remain best effort. A rejected follow-up leaves the preceding run intact.

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

Batch launch uses the same tool/action with nonempty `tasks` and optional `results`
(`together` by default, or `each`). Optional `shared` (tasks only) prepends common
text and a blank line to each own task; whitespace-only shared text is ignored,
and each own task must still be nonblank. Top-level agent/task/name/model/thinking cannot
be mixed with tasks; results requires tasks. Resolve every agent/default, allocate
unique names using the existing naming rules, and check active + batch capacity
before launching anything. Startup is concurrent; return structured per-member
outcomes, excluding startup failures from group membership.

Together members carry one opaque group ID on their current persisted run; no
separate group registry exists. Hold completed results undelivered, but deliver
failures/interruptions and questions immediately. A parent stop marks any
run delivered without a message: the stop tool result is the outcome, and the stopped
run's text is always `Stopped by parent.` Once all current members settle, deliver one
`sidekicks:group` message with full held results plus short status lines for others;
no held results means no message. Sending to a held member releases its result
individually before replacing its run without a group ID. After the runtime becomes
current, `releaseHeld()` flushes restored held completions once; restored active runs
are interrupted as before, with no other notification replay. Each-mode batches use
normal individual delivery, without group IDs or sibling cancellation.

Parent custom entries contain child metadata and latest run outcomes. Child session
files contain the conversation and question transitions. This is not a database or
tool replay log. No transcript-receipt reconciliation is implemented in v1.

On shutdown/reload/new/resume/fork, invalidate the owning runtime before aborting
dialogs, closing navigation, stopping child groups, and releasing writer locks.
Actual tree navigation also replaces the manager without copying old state into the
new branch; cancelled/no-op navigation does not. Only owned children are stopped or
persisted. Returning restores the selected child checkpoints; unresolved runs without
another writer become interrupted and stale questions are cancelled. Foreign writers
remain untouched. Another parent session ID cannot adopt them.

Stop clears child queues, requests abort, then ends stdin and uses bounded SIGTERM /
SIGKILL process-group cleanup. Keep transcripts. A crash-stale lock is replaced
on open if its recorded boot ID differs from the current Linux boot ID, otherwise
only when both recorded PIDs are dead (`removeDeadLock`). Unreadable boot IDs are
undefined and preserve PID checks; unreadable, partial, or same-boot live-PID locks
fail closed. Assumes one host per home directory. No automatic task replay; only
held batch completions are released after restore.

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

`widget.ts` renders compact state below the editor only when the session has
children, including settled conversations available for follow-up. It follows the
nicobailon fleet-status gesture: `ui.onTerminalInput` claims Down only when the
focused component is the main editor (editor-shaped and its text equals
`ctx.ui.getEditorText()`) and that text is empty; every other key closes the list
and passes through. Escape and Up on the first row also close it. Relayed child
dialogs call `suspend()` so they own the keyboard. No overlay and no registered shortcuts. The summary line and rows toggle on click
(fullscreen only). Selection tracks child IDs. Rows show state, name, agent, model,
elapsed time, completed turns and started tool calls for the current assignment,
current/max context, and the first line of a failure; no tool activity or question text.
Counters reset on a new assignment but continue through guidance and answers;
nested and failed tool starts count. Context comes from public RPC `get_session_stats`
at startup, assistant message completion, turn completion, and compaction completion.
Requests are event-driven, not periodic polling; stale replies are ignored, and
missing usage (including after compaction) renders as `—`, never fabricated zero.
Telemetry is optional and cannot fail an assignment. Latest metrics are persisted
with child metadata; old records without counters show `—` until a new assignment.
No cumulative token spend, price, or compaction count is shown. Enter
shows only the storage folder. Order: starting/running/waiting children first in launch
order (rows stay put), then finished ones by end time, newest first; selection tracks the
child ID, so a row that finishes moves under the cursor. Ten rows are visible and the
window follows the selection. Rendering bounds width and row count, and drops
terminal control characters.

`present.ts` holds state glyphs/tones, elapsed formatting, and the plain text the
model reads (child lines, status, delivered question/result). `render.ts` holds the
transcript views: `[sidekick]` message blocks (details carry the body, so views
never parse model text), tool `renderCall`/`renderResult`. A batch is one block with
an outcome-count headline, bounded per-member previews, and full Markdown results
when expanded; it uses the same click/Pi expansion state and control sanitization.
The tool-call header is `subagent <action> <target>` without the prompt. The launch/send/answer/stop
result row is `name agent model`: it is a snapshot taken when the tool returned, so it shows no
glyph, elapsed time, or live state word, only a final state (`stopped`, `completed`, `failed`). Under it
is the parent's prompt from `context.args`: three rows wrapped to the width plus a hidden-row hint, or
Markdown when expanded; an error result keeps its text above the prompt. A batch result lists members
(with `startup failed: <first line>` for a failed start) and shows each full prompt (`shared` plus the
member's task) when expanded. Expansion is Pi's own tool-row state (click in fullscreen, Ctrl+O); no
custom handler. `status` keeps its state and elapsed summary.
Pattern source:
`.refs/nicobailon/pi-subagents/src/tui/subagent-messages.ts` and `fleet-status.ts`.

Serialize child-extension dialogs through one promise chain. Relay select, confirm,
and input to the parent's human UI with cancellation/deadlines. Relay multiline
editor through Pi's public editor component in a cancellable TUI overlay; cancel
with a warning when the parent is RPC-only. Never auto-approve. A child's notify,
widget, title, and editor mutations are dropped and do not reach the parent's UI. Arbitrary child
custom TUIs are unsupported by Pi RPC.

The child environment marker suppresses this package's parent registrations; only
the explicit child entry registers `ask_parent`. Other installed delegation tools
are not hidden. The operator decides whether to disable the old package for a trial.

## Codebase structure

```text
src/
  index.ts     Parent tool/command, lifecycle, delivery, dialog bridge
               → manager, agents, widget
  manager.ts   Child/run/question authority, concurrency, persistence, launch/stop
               → rpc
  rpc.ts       Spawn, JSONL framing/correlation, deadlines, process-group cleanup
               → Node built-ins; Pi protocol types only
  child.ts     Child-only ask_parent and execution-boundary hooks
               → public Pi extension API
  agents.ts    Trusted Markdown discovery, validation, project/user precedence
  widget.ts    Status widget with Down-arrow selection, cancellable editor overlay
  present.ts   Shared state labels and model-facing text
  render.ts    Transcript renderers for messages and tool calls
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
- Real-Pi A/B/C child branching, preserved original artifacts, restoration of an
  in-flight snapshot without dangling tool calls, waiting/no-op tree behavior,
  same-window clone/fork cleanup, independent CLI fork, two parent processes on
  one file, denied foreign operations without state/task writes, explicit takeover
  after release, and suppressed foreign held-batch delivery.
- `send.model` cross-provider recovery after a synthetic quota failure through real
  Pi, saved selection after reload/reopen, retained context and recorded changes;
  invalid overrides submit no prompt, partial RPC failures roll back, running/waiting
  overrides reject, and stop/abort/detach during configuration cannot submit work.
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
- Batch together/each delivery through real Pi, all-or-nothing validation, per-member
  startup failure, immediate failure/process-loss delivery, questions holding groups,
  stop/send release behavior, restored held results without duplicate delivery, and
  bounded/sanitized group rendering. Boot-ID mismatch with a live PID, same-boot
  refusal, legacy PID-only locks, and partial-change follow-up hints.
- Per-assignment turn/tool counters, nested and failed tool starts, persisted metrics,
  real-Pi context usage, stale replies across compaction, and optional telemetry failures.
  One-line metrics verified in fullscreen and regular terminals with a local provider.
- Fullscreen and regular terminal Down-arrow selection, draft preservation,
  unrelated dialogs, collapsed-paste submission, mouse toggles, shutdown cleanup,
  and batch message expansion/click collapse.

Remaining release gate: permission for a real operator provider/MCP smoke, startup
trust behavior in the intended project, coexistence with the old subagent package,
and ambient extension hooks. Parent SIGKILL/escaped descendants remain an explicit
limitation, not a claimed recovery guarantee. The historical research source checks
are useful evidence, not substitutes for these live checks.

The old pi-subagents package must be disabled for a trial because both packages
register `subagent`. Registry records now use `agent`; earlier development records
with only `role` are not restored. No operator sessions or definitions were migrated.

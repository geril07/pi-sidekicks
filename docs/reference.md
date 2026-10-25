# Reference

## Agent definitions

Pi's agent directory defaults to `~/.pi/agent`. Definitions are read from its
`sidekicks/*.md` files and, when trusted, `<cwd>/.pi/sidekicks/*.md`.
Project names override user names. Files are scanned once per session start;
use `/reload` after editing definitions or settings.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Agent name used by `launch` |
| `description` | yes | Short description shown to the parent model |
| `model` | no | Exact `provider/model-id`, or an unambiguous model ID |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, when supported |
| Markdown body | no | Instructions appended to Pi's normal system prompt |

Model/thinking precedence is launch override > agent definition > current parent.
Selections are checked against the child's live model catalog. Unsupported choices
fail instead of silently falling back. The task is separate from the agent body.

Unknown frontmatter is ignored. In particular, `systemPromptMode: replace`, tool
restrictions, and skill filters have no effect. Ordinary Pi skill, extension, and
project-context discovery stays enabled; the parent's conversation is not copied.
Pins in another extension's settings are not imported.

An invalid definition is skipped with one user warning. Duplicate names within a
folder keep the first file in sorted order. Other valid definitions remain usable.

### Use a different directory

Set this in Pi's user settings or trusted project settings:

```json
{
  "sidekicks": {
    "agentsDir": "/path/to/definitions"
  }
}
```

This replaces both default folders with one folder. Relative paths resolve from
the parent's working directory; `~/` is supported. An invalid or missing configured
folder reports an error rather than falling back. Default folders may be absent.

## Parent tools

Both tools have `direct` exposure: they are available as normal tool calls and as
`tools.subagent` / `tools.subagent_group_results` in Pi codemode. Delegation policy
comes from the parent's instructions, not this extension.

### `subagent`

All calls require `action`. Unlisted fields for an action are rejected.

| Action | Required fields | Optional fields | Behavior |
|---|---|---|---|
| `launch` | `agent`, `task` | `name`, `model`, `thinking`, `cwd` | Starts a child and returns after readiness, not task completion |
| `send` | `child`, `message` | `model` | Guides running work or starts a new assignment in the saved conversation |
| `answer` | `child`, `questionId`, `answer` | — | Replies to a pending child question |
| `stop` | `child` | — | Stops active work and retains the conversation |
| `status` | — | — | Lists children, outcomes, questions, and available agents |

Address children by name or stable ID. Names default to the agent name, then
`name-2`, and so on. `cwd` defaults to the parent's working directory. It can be
absolute or relative to the parent and must exist. The child retains it on reopen;
agent definitions still come from the parent's discovery snapshot.

A `model` can carry a thinking suffix, such as `provider/model-id:high`.
On launch, a conflicting `thinking` argument is an error.

`send.model` changes only a finished child's next run and saved selection; it
keeps the name, agent instructions, directory, and conversation. Without a suffix,
keep the child's thinking level. If unsupported by the new model, specify a
supported suffix. There is no separate `send.thinking` or `answer.model`.
Running/waiting model changes are rejected; finish or stop the run first.
Configuration errors submit no prompt. Switching providers sends the retained
conversation to the new provider.

Stop returns its outcome directly; there is no separate stop notification. Stopping
a completed child does not discard a result held for grouped notification, but
can cancel its unanswered nonblocking questions.

### Questions and answers

Children receive `ask_parent({ question, wait })`. It is child-only and model-only;
codemode cannot call it. Omitted `wait` means `true`.

- `wait: true`: pause at a safe tool boundary and notify the parent after settlement.
  One blocking barrier is allowed per run.
- `wait: false`: notify immediately and continue. Multiple questions may be pending,
  and normal guidance remains available.

Reply with the ID in the notification:

```json
{"action":"answer","child":"worker","questionId":"<id>","answer":"Use the existing API."}
```

A blocking reply continues the paused run. A nonblocking reply reaches a running
child at a safe boundary without a new model turn. After that run finishes, the
reply starts another assignment in the same conversation. A planned process close
keeps unanswered nonblocking questions; stop, failure, unexpected process loss,
and parent detach cancel them. Stale or duplicate replies fail.

### `subagent_group_results`

Takes only `children`: 1–64 child names or IDs. Launch separately, then register
selected current assignments. Registration returns immediately; it does not launch
children or wait for completion.

```js
const tasks = [
  { agent: "worker", name: "tests", task: "Run tests. Report failures; do not edit files." },
  { agent: "worker", name: "review", task: "Review the diff. Report findings; do not edit files." }
];
const outcomes = await Promise.allSettled(tasks.map(task =>
  tools.subagent({ action: "launch", ...task })
));
for (let i = 0; i < outcomes.length; i++) {
  const outcome = outcomes[i];
  text({ child: tasks[i].name, startup: outcome.status,
    result: outcome.status === "fulfilled" ? outcome.value : String(outcome.reason) });
}
const started = tasks.filter((_, i) => outcomes[i].status === "fulfilled");
if (started.length) {
  text(await tools.subagent_group_results({ children: started.map(task => task.name) }));
}
```

A fulfilled launch means startup only. A failed startup does not roll back siblings.
When nothing else is left, end the parent turn; notifications wake it.

- Hold future successes until the remaining members finish, fail, are interrupted,
  or are stopped. Send one combined message with held results and short outcome rows.
- Questions, failures, interruptions, and unselected completions stay immediate.
  A waiting blocking question keeps its group open.
- Already finished assignments are omitted. Previously submitted notifications
  cannot be retracted or replayed. Registration is not retroactive.
- Repeating an exact open group is a no-op. Differing overlaps and duplicate aliases
  for the same child are rejected without partial registration.
- An accepted follow-up or late answer releases that member's held result separately
  and removes the old assignment. The next run is ungrouped. A rejected follow-up
  leaves the result and group intact.
- Reload/resume releases owned held results with restore dispositions; it does not
  rerun tasks. No held successes means no extra final wake-up.

There is no group timeout, scheduler, cancel-group action, or implicit all-children
selection. Inspection does not release results.

## Human interface

The widget is hidden until the session has children. It shows name, agent, model,
state, elapsed time, completed turns, started tool calls, and current/max context.
Counters reset per assignment, not per guidance/answer. Nested and failed tool
starts count. Unknown context shows `—`; it is not cumulative token spend or cost.
Failures retain their first line. Tool activity and question text are not shown.

Live rows stay in launch order; finished rows follow newest first. Ten rows are
visible at once, with scrolling. Down from the focused empty editor enters the
list; Up/Down or j/k moves. Enter toggles the folder path, Escape or Up from the
first row leaves, and other input leaves and passes through to the editor.
Drafts, pastes, and unrelated dialogs retain their keys. Fullscreen summary/row
clicks toggle expansion. `/sidekicks` inspects without a model turn.

Transcript messages show expandable `[sidekick]` questions/results. Expanded
messages show full retained Markdown. Tool rows preview the parent's prompt and
use Pi's normal expansion controls. A held result is marked `result held`; a
quarantined group is marked `notification in another window`.

Child confirm/select/input dialogs are relayed to the human, never auto-approved.
Multiline editors use a cancellable overlay with a TUI parent; RPC parents cancel
that dialog with a warning. Arbitrary custom child TUIs cannot be embedded by RPC.

## Storage and lifecycle

Each child lives beside its parent session:

```text
<parent-session-dir>/<parent-session-stem>/sidekicks/<child-id>/
  session.jsonl       Saved Pi conversation
  session.jsonl.lock  Writer lock while a process owns the child
  task-N.md           Exact labelled prompt that started assignment N
  result-N.md         Plain final answer of completed assignment N
```

Registry/checkpoint entries live in the parent's session. Child storage beneath
the parent's project lets aggregate tools such as `ccusage pi daily` include it.
Task/result numbers span branches; existing artifacts are not replaced or deleted.
Writes are best effort. Failed, stopped, or interrupted runs have no result file.
Long delivered results are bounded at 24,000 characters and point to the saved
answer or transcript. Running guidance and blocking answers are not new assignments.

Completed, failed, and interrupted runs release their processes and locks after
delivery. `send` reopens the saved conversation. A blocking question keeps its
process. Up to 64 assignments may be active, including startup and blocking waits;
excess launches are rejected, not queued. This is a safeguard, not a validated
64-process operating scale.

Quit, reload, new/resume/fork, and actual tree navigation stop only this runtime's
owned children. Cancelled/no-op tree navigation leaves them alone. Tree navigation
restores child conversation checkpoints; follow-up creates an alternative child
branch without later messages from the abandoned path. External effects and files
are not rolled back. Interrupted assignments are not replayed automatically.
Old registry records without checkpoints are not restored; their files remain.

### Multiple windows and locks

A second window on the same parent file shows another window's children with saved
status, not live progress. It cannot guide, answer, stop, deliver, or persist them.
After release, explicit `send` can acquire a child at this window's saved checkpoint.
New parent session IDs from clone/fork inherit no children. There is no automatic
takeover or live synchronization.

A group observed as foreign when the runtime is constructed is quarantined for that
runtime, even after release: it will not deliver stale held copies. Explicit
follow-up can still acquire a released child. A later temporary foreign lock only
defers the originating window's delivery until a normal release event.

A stale lock can be replaced when its Linux boot ID differs, or when its recorded
parent and child PIDs are dead. Unknown boot IDs keep PID checks. Unreadable,
partial, or same-boot live-PID locks refuse access. This assumes one host per home
directory; shared homes across hosts/containers can misidentify locks. Do not
manually open a live child's transcript in another Pi process.

## Security and limits

- Children inherit the environment, available credentials, and ordinary Pi resource
  discovery. They have no sandbox or automatic worktree isolation. Coordinate edits.
- Project trust is not bypassed. Untrusted parents pass `--no-approve`. Trusted
  parents leave Pi to evaluate the child's directory. With `defaultProjectTrust:
  "ask"`, headless children need a saved trust decision to load project-local resources.
- This package's parent tools are suppressed inside children. Other installed
  delegation tools remain visible; this is not a universal recursion guard.
- Cancellation is not rollback. Graceful cleanup terminates owned process groups;
  escaped descendants and parent SIGKILL are not covered by that guarantee.
- Across crashes, submitted notifications are not proof of model consumption.
  Exactly-once delivery and durable tool replay are not guaranteed.
- RPC commands have 30-second deadlines, not task timeouts. RPC lines are bounded
  at 64 Mi UTF-16 code units; names at 100 characters and questions at 8,000.

# pi-sidekicks

A personal Pi extension for asynchronous child agents with reusable definitions.

**Status:** first implementation, tested locally with Pi 1.3.0 and scripted models.
The operator runs it from this checkout (a local-path entry in Pi `packages`; the old
pi-subagents entry has empty resource filters), but no real-provider/MCP smoke has been
recorded here.

## Try it

Requires Pi 1.3.x and Node >=22.19.0. From this checkout:

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

This loads the extension for that invocation, without changing Pi settings. For
another working directory, pass the absolute path to `src/index.ts` instead.
Do not load `src/child.ts` manually; the parent loads it only inside children.
Disable pi-subagents for a trial: both extensions register a tool named `subagent`.
The old extension is not hidden or disabled automatically.

## Use

The parent gets two tools, `subagent` and `notify_when_done`; delegation follows the
parent's instructions. Both are `direct`, so codemode can call them as `tools.subagent`
and `tools.notify_when_done` when enabled.

| Action | Required fields | Behavior |
|---|---|---|
| `launch` | `agent`, `task` | Returns after child readiness, not task completion. Optional `name`, `model` (a trailing `:thinking`, as in `openai/gpt-6-luna:xhigh`, sets thinking), `thinking`, `cwd`. |
| `send` | `child`, `message` | Steers running work or starts another assignment in the same conversation. Optional `model` (with `:thinking`) changes a finished child's saved selection before continuing. |
| `answer` | `child`, `questionId`, `answer` | Resumes a blocking question. A nonblocking reply reaches a running child without a new turn; after the run finishes, the reply starts a new run, like `send`. |
| `stop` | `child` | Cancels active work and closes the process, retaining the transcript. It does not discard a completed result held for grouped notification. The tool result is the outcome; no separate message follows. |
| `status` | none | Lists children, latest outcomes, pending questions, and available agents. |

`notify_when_done` takes `children`: 1 to 64 child names or IDs. It registers the
selected current assignments as one future-success notification group and returns
immediately. It does not wait, launch children, or recover an early result.
Children are addressed by `name` or stable ID; a name defaults to the agent name,
then `name-2`, .... Tool results and delivered messages are short plain text, not JSON.

Questions and final results arrive automatically. Progress updates do not wake the
parent model. Up to 64 assignments can be active, including startup and blocking questions.
Completed, failed, and interrupted children release their process after delivery;
`send` reopens the saved conversation. Unavailable selections fail rather than
silently fall back.

To continue a completed, failed, stopped, or interrupted child on another model:

```json
{"action":"send","child":"worker","model":"openai-codex/gpt-6.1-sol:low","message":"Continue the saved work."}
```

The name, instructions, cwd, and conversation stay unchanged. The confirmed selection
is returned and saved for later sends and session reopening. Without `model`, keep
that selection. Without a `:thinking` suffix, keep the child's current thinking level;
if the model does not support it, specify a supported suffix instead. There is no
separate `thinking` field on `send`, and `answer` accepts no model override. Model
changes while running or waiting on a blocking question are rejected; stop first or
finish the current work. Configuration failures do not submit the message or create
a new assignment; partial changes are rolled back, or the process is closed if it
cannot be restored. Switching providers sends the retained context to the new provider.

Children use `ask_parent({ question, wait })`. Omitted `wait` defaults to `true`
(an implementation default, not a user requirement): the child pauses and the
parent is notified after settlement. `wait: false` notifies immediately and lets
work continue, including sibling tools and multiple outstanding questions.
Replies are correlated by question ID. While the child is running, a nonblocking
reply enters that conversation at a safe boundary without a new turn. After the
run finishes, an answer starts a new run with `Answer to <id>:`; use `send` only to
continue without answering. A planned close keeps unanswered nonblocking questions;
stop, failure, unexpected process loss, and parent detach cancel them. Stale or
duplicate replies fail.

### Notification groups

Launch children separately, then register the started ones:

```js
const tasks = [
  { agent: "reviewer", name: "review", task: "Review the change and report findings." },
  { agent: "worker", name: "tests", task: "Run the requested checks and report evidence." }
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
if (started.length) text(await tools.notify_when_done({ children: started.map(task => task.name) }));
```

A launch or notify call returns without waiting for task completion. A fulfilled launch
means startup only; when one launch fails, its siblings are not rolled back. Register
after launches finish starting. An assignment that already finished before registration
is not added and cannot be replayed. Already-queued notifications stay queued; registration
cannot retract them or turn a nonblocking question into a grouped result.

After registration, successful results are held until every remaining member finishes,
fails, is interrupted, or is stopped. Questions, failures, and interruptions still
arrive immediately. An exact repeat registration is a no-op after terminal omissions;
a subset or a different overlap with an open group is rejected rather than merged.
When no held success exists, the group closes without an extra wake-up.

One combined message contains all held results in full and short outcome rows for the
other remaining members. A follow-up or late nonblocking answer to a held member
releases that result individually, removes the old assignment from the group, and
starts an ungrouped run. A rejected follow-up leaves the result and membership intact.
Reload/resume releases held results once after restoring the group; it does not rerun
work or replay other notifications. A second window that observed another writer
quarantines that whole group for its runtime, even after the locks disappear: it does
not redeliver the stale held copy, but an explicit follow-up may still continue the
released child. A later temporary lock only defers the originating window's delivery.
Follow-ups after interruption or stop tell the child to check for partial changes
before repeating work.

### Human status

The widget below the editor is hidden when the session has no children. Once
children exist, it shows a one-line summary (running, waiting, failed, done, stopped)
and remains available for follow-up. Questions and results arrive as transcript messages.

- Down on an empty editor enters the list; any other key goes to the editor as usual.
- Rows show state, name, agent, model, `5 turns · 12 tools · ctx 42k/200k`, and
  elapsed time (plus the first line of a failure). Turns count completed assistant
  cycles; tools count started calls, including nested and failed calls. Both reset
  for a new assignment, not for guidance or an answer. Context is Pi's current
  estimate / model window, not cumulative token spend; unknown values show `—`.
  No tool activity or prompt text. Live children come first, in launch order;
  finished ones follow, newest first. Ten rows show at once, and Up/Down scrolls the
  rest (`↑ N more`, `↓ N more`).
- Up/Down (or j/k) selects, Enter toggles the row's own folder (transcript, prompt and
  result files), Escape or Up on the first row leaves and collapses the list;
  any other key does too and still reaches the editor.
- Clicking the summary expands/collapses it, and clicking a row toggles its details
  (fullscreen mode only). `/sidekicks` enters the list without a keystroke.
- Results, questions, and combined notification messages appear in the transcript as
  collapsible `[sidekick]` blocks; previews are bounded per member, and expansion shows
  each full result as Markdown. Saved historical batch messages keep their old view.
  Tool calls render as `subagent <action> <target>` or
  `notify_when_done <handles>`, with no prompt text. Under launch, send,
  and answer rows, a line shows `name agent model` (no state or time, which would go stale; a
  final state such as `stopped` is shown) and then the prompt you wrote: three wrapped rows
  collapsed, full Markdown when expanded (click the row in fullscreen mode, or the Pi expand key).
  A saved historical batch lists its members, each with its own prompt when expanded;
  a new grouped notification lists the held results and short outcome rows. `status`
  rows keep state and time.

These actions do not spend a model turn. Down is only claimed when the main editor
is focused and empty, so drafts, pastes, and dialogs keep their keys.

### Agent definitions

Read from `~/.pi/agent/sidekicks/*.md`, and from `<cwd>/.pi/sidekicks/*.md` only when the
project is trusted. Project names override user names. An agent definition is:

```markdown
---
name: worker
description: Implement a clearly scoped task
---
Complete the assigned task. Ask the parent when needed; wait only when blocked.
```

Optional frontmatter: `model` (exact `provider/model-id`, or an unambiguous model
ID) and `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, when
supported). Precedence: launch override > agent > current parent. Instructions append
to Pi's normal system prompt. Normal skill/project/extension discovery remains on.
`instructions` is the Markdown body below frontmatter, not a launch argument; `task`
is the assignment. The body is optional; a general agent can have only frontmatter:

```markdown
---
name: general
description: General-purpose agent
---
```

To use a different folder, add this top-level setting to `~/.pi/agent/settings.json`
or trusted project `.pi/settings.json`:

```json
{
  "sidekicks": {
    "agentsDir": "/path/to/my-definitions"
  }
}
```

When set, only that folder is searched, not either default. Relative paths resolve
from Pi's working directory; `~/` is supported. Invalid or missing configured folders
report an error rather than falling back. Omit `agentsDir` to use the defaults.
Existing `agents/` folders are not read or migrated; they remain available for other extensions.

Definitions are read once when a session starts, so `/reload` is needed after changing
settings or definitions. The tool description lists them for the whole session, which keeps
the provider's prompt cache valid; a changed description is a changed tool declaration, and
some providers then re-read the whole prefix. A definition that cannot be used (missing
name or description, invalid `model` or `thinking`, unreadable YAML, a duplicate name; the
file listed first in a folder wins) is skipped, and the user gets one warning with each
file and reason. The other agents keep working and the model is not told. An unusable
`agentsDir` is an error notice instead, and `launch` and `status` report it.

**Legacy migration:** unknown frontmatter is ignored, including tool restrictions,
skill filters, and `systemPromptMode: replace`. Model pins in the old extension's
`settings.json` overrides are not imported. Existing definitions without frontmatter
model/thinking inherit the parent; move pins manually if wanted. No files are rewritten.

## Lifecycle and limits

These are current implementation policies, not permanent product requirements.
See the [constraints audit](docs/scope.md#constraints-audit) for provenance.

- Each child has its own folder beside its parent session:
  `~/.pi/agent/sessions/<project>/<parent-session-stem>/sidekicks/<child-id>/`.
  The folder holds everything about that child:

  ```text
  session.jsonl       Pi's saved conversation (the whole child session)
  session.jsonl.lock  writer lock, present while a process has the child open
  task-N.md           the exact prompt run N started with (label included)
  result-N.md         the final answer of completed run N, plain text
  ```

  Small registry records are stored in the owning parent's session, not a database.
  A blocking answer or running guidance is not a new run, so it has no task file.
  Artifact numbers span all branches and are not reused after tree navigation;
  existing files are never replaced.
  Placing children under the parent's project means `ccusage pi daily` counts
  their tokens and recorded cost with no extra path or named store.
- Children created before the storage change live in the old global
  `~/.pi/agent/sidekick-sessions/` root. With every Pi session closed, run
  `npm run migrate:sidekick-sessions -- --dry-run`, then `--apply`. The script moves
  each folder beside its parent and writes a manifest that `--rollback` can reverse;
  it never edits parent transcripts.
- A completed run writes its full result to `result-N.md` (mode 0600, no front matter,
  so the file can be moved or passed on as it is). Failed, stopped and interrupted runs
  have no result file; their short status text is in the delivery. Delivered results and
  `status` lines for completed children name the file (labelled as the final answer
  only, apart from the whole-session transcript), and a result cut at 24,000
  characters points to it. Task and result writes are best effort: if one fails, the
  run still finishes and a cut result points to the transcript. Nothing deletes these files.
- A parent's text reaches the child with a short label (`Task:`, `Guidance:`, `Follow-up:`,
  `Answer to <id>:`) because Pi runs a prompt that starts with `/` as a command or skill.
  The child's system prompt gets the agent body plus one line saying that its final
  message is the result; it is passed inline, not as a file.
- The fixed ceiling is 64 active assignments; excess work is rejected, not queued.
  Completed, failed, and interrupted runs release their process and lock after
  delivery; a blocking question keeps its process while it waits. Each running child
  is a full Pi process with ambient extensions/MCP; 64-way resource use is not validated.
- Quit, reload, new/resume/fork, and actual tree navigation detach the old runtime
  and stop only its owned children. Cancelled/no-op tree navigation leaves them alone.
  Each saved child state includes a conversation checkpoint: after tree navigation,
  explicit follow-up starts an alternative child branch without later messages from
  the abandoned path. An interrupted assignment is never replayed automatically.
- A second window on the same parent file shows foreign children as **managed by
  another window**, with saved status, not live progress. It cannot send/answer/stop
  them or change their files/state, even on shutdown or tree navigation. Once the
  owner releases a child, explicit `send` may continue from this window's checkpoint.
  This is not live synchronization. New session IDs from clone/fork do not adopt
  children; `pi --fork <path|id>` in another window leaves the original work running.
  A construction-time quarantined notification group is never redelivered by that
  second window; `status` uses the long quarantine sentence and the widget shows
  `notification in another window`.
- Checkpoints are small custom Pi entries; session format and directory layout stay
  unchanged. Old registry snapshots without child checkpoints are not restored or
  migrated. Their transcripts and result files are left untouched.
- Stop/cancellation is not rollback. Effects may already have happened. Process
  loss before settlement is interruption, not success.
- A session writer lock prevents two parent instances reopening the same child.
  After a hard crash a stale `session.jsonl.lock` may remain. Opening the child replaces it
  when its Linux boot ID differs from the current boot, or both recorded PIDs
  (parent and child) are dead. If either boot ID is unavailable, use PID checks.
  Unreadable, half-written, or same-boot live-PID locks still refuse. PIDs are per-machine, so
  two hosts or containers sharing one home directory can misjudge a lock.
  Locks cover this extension; do not manually open a live child in another Pi.
- Exact-once delivery/model consumption across crashes is not guaranteed. Messages
  already submitted to Pi may remain in the owning parent's transcript/queue after
  reload; stale answers are rejected. Registry recovery requires a saved parent session.
- Children work in the parent's directory unless launched with `cwd` (absolute, or relative
  to the parent's; it must be an existing directory). A child outside the parent's
  directory shows `cwd <path>` in status and details. The
  child keeps that directory when reopened. Agent definitions are still discovered from the
  parent's directory. There is no sandbox, tool-managed worktree isolation,
  daemon, nested-sidekicks runtime, transcript viewer, or durable tool replay.
- Child extension confirm/select/input dialogs are relayed to the human. Multiline
  editor dialogs use a cancellable overlay with a TUI parent; with an RPC parent
  they are explicitly cancelled with a warning. RPC cannot embed arbitrary custom TUIs.
- Project trust is not bypassed. Untrusted parents pass `--no-approve` to children. A trusted
  parent passes no flag, so Pi decides for the child's own directory by its usual order:
  extensions, a saved decision in `trust.json`, then `defaultProjectTrust`. Children run
  without a prompt, so with `defaultProjectTrust: "ask"` they skip project-local resources
  (`.pi/mcp.json`, extensions) unless a saved decision covers the directory; `"always"` loads them.
  Other installed delegation tools remain visible; the recursion guard covers this
  extension, not every package in the operator's setup.
- While any child is starting or running, the parent emits `herdr:busy` on `pi.events`
  (`{ active }`, strictly paired), so a Herdr Pi integration that counts it keeps the
  pane working after the parent turn ends. A child waiting on a question does not
  count; its question wakes the parent. Upstream Herdr ignores this event: the
  operator's patched `herdr-agent-state.ts` consumes it, and a Herdr reinstall removes it.
- Graceful cleanup interrupts tools and terminates owned process groups. Arbitrary
  descendants after parent SIGKILL, or tools that escape their group, are not guaranteed.

## Development and verification

```sh
npm run check
npm test
npm run test:tui  # optional: requires tmux
```

Tests use isolated agent directories under `/tmp/opencode`, real Pi RPC processes,
scripted local providers, and a fake RPC peer. No billable model or external MCP
call is needed. The suite includes real-Pi codemode `on`/`only` checks for parent tool
publication, raw unknown-key errors, nested launch/registration, grouped delivery,
and reload. The terminal smoke uses its own named tmux server and checks both
terminal modes, draft/cursor/paste preservation, unrelated dialogs, summary clicks,
child-extension dialogs, and combined notification message expansion/click collapse.
It saves text evidence under `/tmp/opencode`.

Before replacing the existing setup, obtain permission for a live provider/MCP
smoke and test coexistence with the operator's actual extensions.

## Start here

- [V1 scope](docs/scope.md): current user requirements; authoritative over earlier research.
- [Implementation brief](docs/implementation-brief.md): technical design, source structure, verification, and remaining risks.
- [Architecture](docs/architecture.md): original research proposal; the brief records current decisions.
- [Operator baseline](docs/operator-baseline.md): relevant existing configuration, without credentials.
- [Research](docs/research.md): findings, trade-offs, size estimates, and uncertainty.
- [References](references/README.md): cloned sources, reviewed alternatives, and exact revisions.

## Local sources

Selected upstream repositories are shallow Git clones under `.refs/<owner>/<repo>/`.
They are ignored, not vendored, installed, or loaded as Pi extensions.
`references/lock.json` records their exact commits and measured source sizes.
See the reference index to restore them on another checkout.

## Repository boundaries

This is separate from the operator's dotfiles repository. Implementation installed
development dependencies only in this checkout. It did not change Pi settings,
replace the existing extension, modify references, or add a GitHub remote.

# pi-sidekicks

A personal Pi extension for asynchronous child agents with reusable definitions.

**Status:** first implementation, tested locally with Pi 1.3.0 and scripted models.
The operator's real provider/MCP configuration has not been smoke-tested. This
extension is not installed or enabled in the operator's settings.

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

The parent gets one `subagent` tool; delegation follows the parent's instructions:

| Action | Required fields | Behavior |
|---|---|---|
| `launch` | `agent`, `task`, or `tasks` | Returns after child readiness, not task completion. Single launch: optional `name`, `model` (a trailing `:thinking`, as in `openai/gpt-6-luna:xhigh`, sets thinking), `thinking`, `cwd`. Batch: tasks take the same optional fields; optional `results`, `shared`. |
| `send` | `child`, `message` | Steers running work or starts another assignment in the same conversation. |
| `answer` | `child`, `questionId`, `answer` | Resumes a blocking question, or delivers a nonblocking reply without restarting idle work. |
| `stop` | `child` | Cancels work and closes the process; retains the transcript. The tool result is the outcome; no separate message follows. |
| `status` | none | Lists children, latest outcomes, pending questions, and available agents. |

Children are addressed by `name` (unique; defaults to the agent name, then `name-2`, ...).
Tool results and delivered messages are short plain text, not JSON.

Questions and final results arrive automatically. Progress updates do not wake the
parent model. Up to 64 assignments can be active, including startup and blocking questions;
completed children can remain idle for follow-up. Model/thinking stay fixed after
launch, and unavailable selections fail rather than silently fall back.

Children use `ask_parent({ question, wait })`. Omitted `wait` defaults to `true`
(an implementation default, not a user requirement): the child pauses and the
parent is notified after settlement. `wait: false` notifies immediately and lets
work continue, including sibling tools and multiple outstanding questions.
Replies are correlated by question ID and enter that same conversation at a safe
boundary. A late nonblocking answer is retained without reopening the completed
assignment or spending a model turn; use `send` explicitly if more work is needed.
Nonblocking questions do not prevent ordinary guidance or follow-up. Stop, failure,
process loss, and parent detach cancel unanswered questions; stale/duplicate replies fail.
An idle child retains unanswered nonblocking questions across ordinary follow-ups.

### Batch launch

Use `subagent` with `action: "launch"` and a nonempty `tasks` array:

```json
{"action":"launch","tasks":[{"agent":"worker","task":"Review src/manager.ts","name":"runtime"},{"agent":"worker","task":"Review tests","name":"tests"}],"results":"together"}
```

Each task accepts `agent`, `task`, and optional `name`, `model`, `thinking`.
Optional `shared` text is prepended to each entry's own `task` with a blank line; whitespace-only `shared` is ignored, and each own task must still be nonblank.
Do not mix `tasks` with those top-level fields. `results` is valid only with
`tasks`: `together` (default) holds completed results until every member settles;
`each` delivers each result separately. Agent/default resolution, names, and capacity
are checked for the whole batch before any child starts. Members then start
concurrently; startup failures appear per member in the tool result and are excluded
from the group.

With `together`, failures, interruptions, and questions arrive immediately; siblings
keep running. Waiting for an answer still counts as active. Stopping a grouped member
sends no cancellation message. When all settle, one group message contains all held
results in full and short status lines for the other members. With no held result,
there is no group message. Sending new work to a member releases its held result
individually first, and the new run leaves the group. Reload releases held results
once after restoring the group; it does not rerun work or replay other notifications.
Follow-ups after interruption or stop tell the child to check for partial changes
before repeating work.

### Human status

The widget below the editor is hidden when the session has no children. Once
children exist, it shows a one-line summary (running, waiting, failed, done, stopped)
and remains available for follow-up. Questions and results arrive as transcript messages.

- Down on an empty editor enters the list; any other key goes to the editor as usual.
- Rows show state, name, agent, model and elapsed time (plus the first line of a
  failure). No tool calls or prompt text. Live children come first, in launch order;
  finished ones follow, newest first. Ten rows show at once, and Up/Down scrolls the
  rest (`↑ N more`, `↓ N more`).
- Up/Down (or j/k) selects, Enter toggles the row's storage folder (transcript and
  result files), Escape or Up on the first row leaves and collapses the list;
  any other key does too and still reaches the editor.
- Clicking the summary expands/collapses it, and clicking a row toggles its details
  (fullscreen mode only). `/sidekicks` enters the list without a keystroke.
- Results, questions, and batches appear in the transcript as collapsible `[sidekick]` blocks;
  batch previews are bounded per member; expansion shows each full result as Markdown.
  Tool calls render as `subagent <action> <target>`.

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
Use `/reload` after changing settings or definitions. Existing `agents/` folders
are not read or migrated; they remain available for other extensions.

**Legacy migration:** unknown frontmatter is ignored, including tool restrictions,
skill filters, and `systemPromptMode: replace`. Model pins in the old extension's
`settings.json` overrides are not imported. Existing definitions without frontmatter
model/thinking inherit the parent; move pins manually if wanted. No files are rewritten.

## Lifecycle and limits

These are current implementation policies, not permanent product requirements.
See the [constraints audit](docs/scope.md#constraints-audit) for provenance.

- Each child has its own saved Pi conversation under Pi's user-data directory.
  Small registry records are stored in the owning parent's session, not a database.
- Every finished run (completed, failed, stopped or interrupted) also writes its full
  result to `<child-id>.<run-id>.result.md` beside the transcript, mode 0600, with
  front matter (child, agent, model, state, times, transcript path). Delivered
  results and `status` lines for finished children name this file (labelled as the final
  answer only, apart from the whole-session transcript), and a result cut at 24,000
  characters points to it. The
  write is best effort: if it fails, the run still finishes and the cut result points
  to the transcript. Nothing deletes these files.
- The fixed ceiling is 64 active assignments; excess work is rejected, not queued.
  Idle processes remain alive and do not consume assignment slots. Each child is a
  full Pi process with ambient extensions/MCP; 64-way resource use is not validated.
- Quit, reload, new/resume/fork, and tree navigation detach the old runtime and stop
  owned children. Returning to the owning session permits explicit follow-up; an
  interrupted assignment is never replayed automatically.
- Stop/cancellation is not rollback. Effects may already have happened. Process
  loss before settlement is interruption, not success.
- A session writer lock prevents two parent instances reopening the same child.
  After a hard crash a stale `.jsonl.lock` may remain. Opening the child replaces it
  when its Linux boot ID differs from the current boot, or both recorded PIDs
  (parent and child) are dead. If either boot ID is unavailable, use PID checks.
  Unreadable, half-written, or same-boot live-PID locks still refuse. PIDs are per-machine, so
  two hosts or containers sharing one home directory can misjudge a lock.
  Locks cover this extension; do not manually open a live child in another Pi.
- Exact-once delivery/model consumption across crashes is not guaranteed. Messages
  already submitted to Pi may remain in the owning parent's transcript/queue after
  reload; stale answers are rejected. Registry recovery requires a saved parent session.
- Children work in the parent's directory unless launched with `cwd` (absolute, or relative
  to the parent's; it must be an existing directory, and one bad entry rejects a whole
  batch). A child outside the parent's directory shows `cwd <path>` in status and details. The
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
call is needed. The terminal smoke uses its own named tmux server and checks both
terminal modes, draft/cursor/paste preservation, unrelated dialogs, summary clicks,
child-extension dialogs, and batch message expansion/click collapse. It saves text
evidence under `/tmp/opencode`.

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

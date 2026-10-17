# pi-sidekicks

A personal Pi extension for a few asynchronous, role-based child agents.

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
The old subagent extension is not hidden or disabled automatically.

## Use

The parent gets one `sidekick` tool; delegation follows the parent's instructions:

| Action | Required fields | Behavior |
|---|---|---|
| `launch` | `role`, `task` | Returns after child readiness, not task completion. Optional `name`, `model`, `thinking`. |
| `send` | `child`, `message` | Steers running work or starts another assignment in the same conversation. |
| `answer` | `child`, `questionId`, `answer` | Resumes a blocking question, or delivers a nonblocking reply without restarting idle work. |
| `stop` | `child` | Cancels work and closes the process; retains the transcript. |
| `status` | none | Lists children, latest outcomes, pending questions, and available roles. |

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

### Human status

- `Ctrl+Alt+S`: collapse/expand the widget above the editor.
- `Ctrl+Alt+N` or `/sidekicks`: enter arrow navigation.
- Up/Down selects; Left/Right collapses/expands; Enter shows bounded details.
- Escape closes navigation and restores editor focus without replacing the draft.
- Clicking the summary toggles it in Pi fullscreen mode. Use keyboard controls in
  regular mode; no terminal setting is changed automatically.

These status actions do not spend a model turn. Use `/sidekicks` if another
extension consumes these shortcuts.

### Roles

Read from `~/.pi/agent/agents/*.md`, and from `<cwd>/.pi/agents/*.md` only when the
project is trusted. Project names override user names. A role is:

```markdown
---
name: worker
description: Implement a clearly scoped task
---
Complete the assigned task. Ask the parent when needed; wait only when blocked.
```

Optional frontmatter: `model` (exact `provider/model-id`, or an unambiguous model
ID) and `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, when
supported). Precedence: launch override > role > current parent. Instructions append
to Pi's normal system prompt. Normal skill/project/extension discovery remains on.

**Legacy migration:** unknown frontmatter is ignored, including tool restrictions,
skill filters, and `systemPromptMode: replace`. Model pins in the old extension's
`settings.json` overrides are not imported. Existing roles without frontmatter
model/thinking inherit the parent; move pins manually if wanted. No roles are rewritten.

## Lifecycle and limits

These are current implementation policies, not permanent product requirements.
See the [constraints audit](docs/scope.md#constraints-audit) for provenance.

- Each child has its own saved Pi conversation under Pi's user-data directory.
  Small registry records are stored in the owning parent's session, not a database.
- The fixed ceiling is 64 active assignments; excess work is rejected, not queued.
  Idle processes remain alive and do not consume assignment slots. Each child is a
  full Pi process with ambient extensions/MCP; 64-way resource use is not validated.
- Quit, reload, new/resume/fork, and tree navigation detach the old runtime and stop
  owned children. Returning to the owning session permits explicit follow-up; an
  interrupted assignment is never replayed automatically.
- Stop/cancellation is not rollback. Effects may already have happened. Process
  loss before settlement is interruption, not success.
- A session writer lock prevents two parent instances reopening the same child.
  After a hard crash a stale `.jsonl.lock` may remain: inspect its recorded PID and
  verify the owner and child are gone before removing that specific lock. Recovery
  is deliberately fail-closed, not automatic.
  Locks cover this extension; do not manually open a live child in another Pi.
- Exact-once delivery/model consumption across crashes is not guaranteed. Messages
  already submitted to Pi may remain in the owning parent's transcript/queue after
  reload; stale answers are rejected. Registry recovery requires a saved parent session.
- Children share the working directory. There is no sandbox, worktree isolation,
  daemon, nested-sidekicks runtime, transcript viewer, or durable tool replay.
- Child extension confirm/select/input dialogs are relayed to the human. Multiline
  editor dialogs use a cancellable overlay with a TUI parent; with an RPC parent
  they are explicitly cancelled with a warning. RPC cannot embed arbitrary custom TUIs.
- Project trust is not bypassed. Untrusted parents pass `--no-approve` to children.
  Other installed delegation tools remain visible; the recursion guard covers this
  extension, not every package in the operator's setup.
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
and child-extension dialogs. It saves text evidence under `/tmp/opencode`.

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

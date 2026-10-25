# Development

## Setup and checks

```sh
npm ci --ignore-scripts
mkdir -p /tmp/opencode
npm run check
env -u PI_SIDEKICKS_CHILD -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_CHILD_AGENT PI_OFFLINE=1 npm test
env -u PI_SIDEKICKS_CHILD -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_CHILD_AGENT PI_OFFLINE=1 npm run test:tui
```

Node >=22.19.0 runs the TypeScript tests directly. The terminal smoke also needs
`tmux`. Tests launch the Pi CLI from local `node_modules`, not the global `pi`.
They use isolated agent directories, scripted providers, and fake RPC peers.
They need no paid model, external MCP server, or operator configuration changes.
The existing test drivers save evidence under `/tmp/opencode`.

Clear the child markers: otherwise nested Pi processes suppress this extension,
which causes timeouts. `PI_OFFLINE=1` disables Pi's automatic network activity.

CI runs the type check, test suite, and terminal smoke on Linux with Node 22.19.0
and Pi 1.3.0 / 1.4.0. This matrix is not a claim of Windows/macOS verification.
The package smoke packs and extracts the actual distribution, installs it into an
isolated Pi configuration, and exercises launch, question, answer, and completion.

## Architecture

One parent extension owns ordinary Pi RPC child processes. Pi owns the model loop,
tools, credentials, resource discovery, and saved transcripts. A process is
replaceable; a child conversation is persistent. There is no daemon or alternate
execution backend.

| File | Responsibility |
|---|---|
| `src/index.ts` | Parent tools/command, lifecycle, notifications, human dialog bridge |
| `src/manager.ts` | Child/run/question state, ownership, checkpoints, grouping, launch/stop |
| `src/rpc.ts` | Process startup, JSONL framing/correlation, deadlines, cleanup |
| `src/child.ts` | Child-only questions, pause barriers, checkpoint/answer commands |
| `src/agents.ts` | Definition discovery, validation, model suffix parsing |
| `src/widget.ts` | Compact status, keyboard/mouse navigation, cancellable editor |
| `src/present.ts` | Shared labels and model-facing text |
| `src/render.ts` | Transcript message and tool-call views |

The manager is the state authority. Widgets and status use snapshots; they do not
infer a second lifecycle from UI activity. Child, assignment, and question have
separate identities. Runtime processes and writer locks are not conversations.

### Execution and delivery

Startup resolves the definition and selection, acquires the child writer lock,
starts the parent's Pi CLI in RPC mode, and verifies the child's catalog, effective
selection, and session path before submitting a prompt. Agent instructions append
to Pi's normal prompt. `Task:`, `Guidance:`, `Follow-up:`, and `Answer to <id>:`
labels prevent task text beginning with `/` from becoming a Pi command.

Classify outcomes at `agent_settled`, not prompt acceptance, `agent_end`, or exit.
Explicit stop wins a settlement race. An accepted blocking question means waiting;
provider errors mean failure; unexplained abort/process loss means interruption.
Otherwise save the final assistant text as the result.

Question/result notifications use custom messages with `triggerTurn` and
`deliverAs: "steer"`, so a busy parent can react at a safe boundary rather than
waiting for its entire run to end. Progress updates only the widget.
Group membership belongs to current runs; there is no separate group registry.
Exact model-visible declarations and output text live in source, not copied here.

### Blocking questions

At finalized assistant `message_end`, reserve the first valid direct blocking
`ask_parent` when no guidance/follow-up is pending. Block sibling effects with
terminating error results. Persist the question and return `terminate: true`.
If guidance or a non-terminating sibling result prevents a clean barrier, withdraw
the question and continue. Otherwise abort at `turn_end` after complete tool
history, with a final `agent_before_settle` guard. Notify only after settlement.
An answer uses a framed prompt in the same session.

Nonblocking questions append their entries and return normally: no barrier,
sibling blocking, or settlement abort. Running nonblocking replies use the
child-only answer command and a steering message without triggering a new turn.

### Checkpoints and ownership

Child checkpoint entries mark safe conversation boundaries outside unfinished
tool batches. Parent registry snapshots retain each child's checkpoint leaf.
Reopening must acknowledge restoration before a prompt is submitted; a handled
slash command alone is not proof of success.

Acquire a writer lock before restoring context, publishing artifacts, or changing
state. Task/result files are published through same-directory hard links so a
branch cannot replace earlier artifacts. Artifact failures do not fail the run.
The public ownership, restore, and crash limits are in [the reference](reference.md).

Use raw JSONL transport because Pi's public RPC client cannot answer extension UI
requests. Correlate response IDs; commands can finish out of order. Bound each line
before ordinary JSON parsing. Telemetry is event-driven and optional: stale or
missing context replies cannot fail a task or fabricate zero usage.

### Integration boundary

Children inherit normal Pi provider/extension/MCP discovery, subject to trust.
This extension only suppresses its own parent tools inside children. It adds no
skill filtering or special parent-history inheritance system.

While a child starts/runs, `pi.events` emits paired `herdr:busy` events with
`{ active }`; blocking waits do not count. This requires an integration that
consumes the event. Upstream Herdr does not consume it automatically.

## Design constraints

Keep direct parent-child delegation, saved-conversation follow-up, correlated
questions, automatic delivery, explicit selections, and compact human inspection.
Preserve normal editor behavior and ordinary Pi discovery. A few typical children
must not become a low concurrency limit.

A transcript viewer, embedded child TUI, parent-history fork, scheduler, daemon,
worktree manager, and durable tool replay are not implemented. These are scope
boundaries, not permanent bans. Add features for a concrete need, not to reproduce
a larger orchestration framework. Engineering bounds are safeguards, not user
requirements. Historical proposals are not approval to implement new behavior.

## Legacy storage utility

Only pre-release users with `~/.pi/agent/sidekick-sessions/` need this. Close all Pi
sessions, then run from the checkout:

```sh
npm run migrate:sidekick-sessions -- --dry-run
npm run migrate:sidekick-sessions -- --apply
```

The script moves child folders beside their parent, without editing parent
transcripts, and writes a rollback manifest. Inspect `--help` for `--rollback`,
custom paths, and live-lock handling. The runtime has no legacy-path fallback.

## Release checks

- Run the checks above for each supported Pi version. Update the supported range
  only after verification; do not widen it just to remove peer warnings.
- Test real provider/MCP loading, intended project trust, and coexistence with other
  extensions before claiming those integrations work. Obtain permission for any
  paid call or operator settings change.
- Review current files and Git history for credentials and unwanted personal data
  before the first public push. Removing a file does not remove it from history.
- Inspect `npm pack --dry-run --ignore-scripts`. The allowlist includes source,
  user/developer docs, license, and the migration utility; not tests or research.
- Keep npm publication disabled until a package name/ownership and publishing
  authentication are settled. `pi-sidekicks` is already registered on npm; ownership
  has not been established. Git installation does not require npm publication.

Earlier requirements, audits, comparisons, and operator snapshots remain in Git
history before this cleanup. Pinned upstream research sources are listed in
[the reference index](https://github.com/geril07/pi-sidekicks/tree/main/references).

# pi-sidekicks

Asynchronous child agents for [Pi](https://github.com/earendil-works/pi).
Delegate work, keep using the parent session, and receive questions and results
without polling. Continue a child's saved conversation when you need a follow-up.

- Markdown agent definitions with per-task model and thinking overrides.
- Guidance and blocking or nonblocking questions between parent and child.
- Optional grouped result notifications.
- A compact status widget with keyboard navigation.

## Requirements

- Pi 1.3.x or 1.4.x and Node.js >=22.19.0.
- At least one agent definition (see below).

Local tests use scripted providers. Live provider/MCP compatibility is not yet
verified. Children run ordinary Pi processes with your available tools and
credentials; **this is not a sandbox**.

## Install

```sh
pi install git:github.com/geril07/pi-sidekicks
```

Or try a local checkout without changing Pi settings:

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

Use an absolute entrypoint path from another directory. Load only `src/index.ts`;
`src/child.ts` is loaded by the parent inside children.

Disable any other extension that registers `subagent` before trying this one.
It is not disabled automatically. There is no npm release from this repository yet.

## Define an agent

Create `~/.pi/agent/sidekicks/worker.md`:

```markdown
---
name: worker
description: Implement a clearly scoped task
---
Complete the assigned task. Ask the parent when blocked.
```

Run `/reload` after adding or changing definitions. Trusted projects can also
provide `.pi/sidekicks/*.md`; project definitions override user definitions by name.
No agents are bundled, and existing `agents/` directories are not read.

## Use

Ask Pi to delegate a task to `worker`. The model can call:

```json
{"action":"launch","agent":"worker","name":"tests","task":"Run the tests and report failures. Do not change files."}
```

Launch returns after startup, not completion. Questions and results arrive
automatically. The parent can do other work or end its turn while the child runs.
For follow-up work in the same conversation:

```json
{"action":"send","child":"tests","message":"Investigate the first failure. Do not change files."}
```

`subagent` also supports `answer`, `stop`, and `status`.
`subagent_group_results({ children: ["tests", "review"] })` combines future
successful results from selected current assignments; questions and failures
still arrive immediately.

## Inspect and stop

The widget appears below the editor once children exist. Press Down from an empty
editor, or use `/sidekicks`, to select a child. Up/Down moves, Enter shows its
storage folder, and Escape leaves. Fullscreen mode also supports summary/row clicks.
Questions and results appear as expandable transcript messages.

Stopping a child retains its conversation and files. It **does not undo changes**.
Children share the parent's directory unless launched with `cwd`; coordinate
concurrent edits yourself. Interrupted work is not automatically replayed.

## Documentation

- [Reference](docs/reference.md): tools, definitions, settings, storage, and lifecycle.
- [Development](docs/development.md): architecture, testing, and release checks.
- [MIT license](LICENSE).

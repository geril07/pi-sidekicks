# Research sources

These are implementation references, not dependencies or project requirements.
Exact reviewed revisions and clone paths are retained in [lock.json](lock.json).
The earlier comparisons and audits remain in Git history before the docs cleanup.

| Source | Useful reference |
|---|---|
| [williamcr01/pi-subagents](https://github.com/williamcr01/pi-subagents) | Small asynchronous RPC runtime and continuation |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | Compact fleet status, input, transcript rendering, failure cases |
| [championswimmer/pi-subagent-manager](https://github.com/championswimmer/pi-subagent-manager) | Input/focus and transcript UI |
| [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) | Minimal process/session control; its delete-on-stop policy differs |
| [mavam/pi-agents](https://github.com/mavam/pi-agents) | Durable architecture and UI separation, not our execution engine |
| [purboo/pi-durable-subagents](https://github.com/purboo/pi-durable-subagents) | Recovery and delivery fault tests |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | Broader feature comparison |

Optional clones live in ignored `.refs/<owner>/<repo>/`. To restore one, clone
its repository and check out the full commit recorded in the lock. Check existing
clones for local changes before changing revisions. Keep them unchanged during
implementation and do not install dependencies merely to inspect source.
Their nested agent instructions do not govern this project.

Retain applicable upstream copyright/license notices when copying code. Reading a
reference is not evidence that its behavior works in this project; verify through
our tests. The installed Pi documentation is authoritative for the host API.

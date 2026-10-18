# V1 scope

Updated from the user's latest setup request on 2026-10-16 (operator local date).
This document supersedes the broader viewer-first recommendations in the research.
The first implementation now covers this scope in source. Local scripted-provider
verification and remaining live-integration gaps are recorded in
[the implementation brief](implementation-brief.md); this is not a claim that the
operator's provider/MCP setup has been verified.

## Product intent

A small personal extension for asynchronous Pi child agents. Typical use of a few
children is not a concurrency requirement. The operator values direct control, visible progress, and a small
model-facing API over a general orchestration framework.

This is a separate project, not a commitment to maintain a fork of the current
large extension. The first implementation starts fresh over ordinary Pi RPC.

## Confirmed requirements

- Asynchronous delegation: launching a child releases the parent to do other work.
- Markdown-defined roles with reusable instructions.
- Per-launch model and thinking overrides, not only fixed role defaults.
- Parent-to-child guidance and child-to-parent questions with an answer path.
- Questions can ask-and-continue or ask-and-wait. A typical child count must not
  become a low concurrency limit; the user suggested a ceiling around 64.
- Keep test drivers in TypeScript, including the optional real-terminal smoke.
- Continue a child's conversation rather than rediscovering prior work in a new agent.
- MCP adapter and the operator's provider extensions must work inside children.
- Completion delivery should not require repetitive status polling or shell/file inspection.
- A compact live status widget appears near the main editor when relevant. The
  user's later correction hides it when the session has no children; existing
  child conversations keep status/results available for follow-up.
- The widget can collapse and expand, including clicking its visible summary.
- Arrow-key navigation can enter and move through child rows, comparable to the
  current nicobailon compact status UI. Preserve normal editor input outside that mode.
- Show useful identity/progress: role or name, model, state, and bounded current activity.
  Exact labels and placement are not settled.
- UX correction (2026-10-18): the first widget was rejected. Follow the nicobailon
  pattern: Down from the editor enters the list; no shortcut hints in the status
  line; `Ctrl+Alt+N` did not work for the operator and was removed. Results and
  questions need real transcript rendering (tool call, message blocks), not raw JSON.
  Agent-facing names, descriptions, and tool API are open to redesign.

## Explicitly deferred or simplified by the latest request

- A child transcript viewer/fullscreen inspector is not a v1 requirement.
  A ready-made implementation could be reconsidered later; it is not a reason to expand v1 now.
- Full interactive child Pi TUI embedding is not required.
- Forking the parent's conversation is deferred. Prefer an explicit task handoff.
- Skill allowlists, skill filtering, and a separate skill inheritance system are unwanted.
  Let normal child Pi skill discovery operate.
- Project context is low priority. If ordinary Pi discovery supplies it, keep that.
  A dedicated inheritance/stripping option is not required.

The operator's older roles use more frontmatter than this scope needs.
Do not treat every legacy option as a compatibility requirement.

## Priorities retained from the earlier discussion

- Durable tool-step execution is non-critical.
- Workflow scripts are optional and low value for typical small workloads; this is
  not a concurrency bound or a permanent exclusion.
- Excessive guides, permission machinery, status updates, and scope negotiations
  are part of the problem, not features to reproduce.
- Inspection by a human should not require spending a model turn.
- Agents should ask when genuinely blocked, not routinely reconfirm an adequate task.

## Recommended initial exclusions (proposal)

Keep the first implementation to direct parent-child work. Avoid a scheduler,
nested delegation, multiple execution backends, watchdog models, automatic review
gates, external CLI runners, a new permission framework, and a daemon.

These are scope-control recommendations, not claims that the user banned those
features permanently. Revisit only for a concrete need.

## Role settings

Current interface terminology is **agent**, not role: the `subagent` tool selects a
Markdown definition with `agent`. Earlier scope/history used the word role.
The user requested separate definition discovery: use `sidekicks/` instead of
`agents/` by default, with an optional `sidekicks.agentsDir` setting in Pi config
to select a single replacement folder. Do not add a CLI flag or rewrite the other
extension's definitions/settings.

Required: an agent name and description. The instruction body and model/thinking
are optional; the user's later correction allows a general agent with no body.
Use the existing role files as use cases, not as a schema to copy wholesale.

Precedence is per-launch override > role default > current parent default.
Model selection must use Pi's actual available
catalog and disclose the effective model/thinking rather than silently substitute.

Initial implementation choices: append role instructions to the normal Pi prompt,
ignore legacy tool/skill restrictions, and keep model/thinking fixed for a child's
conversation. No mutable-defaults interface is added. These defaults can be adjusted
after the first implementation; see the implementation brief.

## Constraints audit

Provenance: the pre-implementation scope at commit `516e86c1682a4d82ea80ab1932e16261d9e2cc9a`
and the later corrections in `../handoff-v1-corrections.md`. The full original
exploration transcript is unavailable; this audit cannot establish intent beyond
those records. Existing source is evidence of implementation, not user approval.

| Restriction or decision | Provenance and current disposition |
|---|---|
| Three active assignments | Assistant-inferred from typical usage, not a requirement. Replaced with a fixed ceiling of 64 active assignments, including startup and blocking waits; no queue/configuration added. 64 is a chosen ceiling following the user's suggestion, not a tested operating scale. |
| Always-blocking questions, one pending question, no ordinary guidance while pending | Assistant choices, superseded by the correction. `ask_parent.wait` is optional and defaults to `true` to preserve existing calls. `false` permits multiple outstanding questions and normal guidance; blocking pauses still reserve one safe barrier. |
| Nonblocking late-answer policy | New implementation decision: retain replies in the same conversation without a model turn or reopening the completed assignment. Explicit `send` starts further work. Unanswered nonblocking questions survive normal follow-ups but are cancelled on stop, failure, process loss, or parent detach. |
| Model/thinking frozen for the conversation | Assistant choice. Original scope required launch overrides and left changes on later runs undecided. Retained for this change, not a permanent ban. |
| Mandatory predefined role; shared parent cwd; no per-launch cwd | Assistant interface simplifications. Roles were required, but mandatory role selection and shared cwd were not. Retained, not expanded here. |
| Append-only role prompts; ignored legacy settings model pins | Assistant prompt/migration choices. Append versus replace was originally open; legacy compatibility was not required. Retained and disclosed in README. |
| Children told not to delegate; this package's parent tools suppressed in children | Assistant recursion/scope policy. Nested delegation was only a proposed exclusion. Retained for v1, not a user ban on all delegation tools. |
| Tool description forbids delegation unless explicitly requested | Coding-agent instructions were copied into product policy without a scope requirement. Removed from the tool description; actual parent instructions still govern delegation. |
| Parent and child tools are model-only | Assistant execution-interface choice, not a user prohibition on codemode/scripts. Retained. |
| Stop closes the process; reload/new/resume/fork/tree stop all children | Assistant lifecycle decisions. Original scope asked for explicit tested behavior, not these exact policies. Retained. |
| No launch queue or cross-parent adoption | Assistant simplifications, not recorded user requirements. Retained. Stale-lock recovery was added 2026-10-18 at the operator's request, limited to locks whose recorded PIDs are dead. |
| Python terminal driver | Assistant convenience only. Replaced with TypeScript and Node built-ins; tmux coverage stays optional. |

Separate engineering bounds remain: 30-second RPC command deadlines (not task
timeouts), an 8 MiB RPC-line bound, 8,000-character questions, 100-character names,
24,000-character result summaries with full transcripts retained, and eight visible
widget rows with navigation. Their exact values are assistant-selected safeguards,
not requirements or consequences of the typical child count. This correction does
not remove them automatically.

Deferred viewers, full child TUIs, parent-history forks, and workflow machinery are
not forbidden features. Skill filtering was explicitly unwanted; ordinary child
discovery, provider/MCP support, conversation reuse, automatic delivery, and the
compact UI remain confirmed requirements. No operator settings/install changes or
billable integration calls are authorized by this audit.

## V1 verification scenarios

Use these as observable acceptance targets when implementation is requested:

1. Launch independent roles; the parent remains usable while children work.
2. A requested model/thinking reaches the child, including extension-provided models.
3. A child performs a real call through the configured MCP adapter.
4. Guidance reaches a running child; a question receives an answer and work continues.
5. Completion arrives without a polling loop or a required guide lookup.
6. A settled child accepts follow-up work with its prior conversation.
7. The status widget updates, collapses/expands, and supports arrow navigation
   without stealing an editor draft or unrelated dialog input.
8. Cancellation retains the conversation; status does not invent success.
9. Reload, parent replacement, and process loss have explicit, tested behavior.
   Automatic recovery after every failure is not required.

The last two scenarios need lifecycle decisions; see the architecture document.

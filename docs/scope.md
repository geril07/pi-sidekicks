# V1 scope

Updated from the user's latest setup request on 2026-10-16 (operator local date).
This document supersedes the broader viewer-first recommendations in the research.
The first implementation now covers this scope in source. Local scripted-provider
verification and remaining live-integration gaps are recorded in
[the implementation brief](implementation-brief.md); this is not a claim that the
operator's provider/MCP setup has been verified.

## Product intent

A small personal extension for a few asynchronous Pi child agents, usually no more
than three. The operator values direct control, visible progress, and a small
model-facing API over a general orchestration framework.

This is a separate project, not a commitment to maintain a fork of the current
large extension. The first implementation starts fresh over ordinary Pi RPC.

## Confirmed requirements

- Asynchronous delegation: launching a child releases the parent to do other work.
- Markdown-defined roles with reusable instructions.
- Per-launch model and thinking overrides, not only fixed role defaults.
- Parent-to-child guidance and child-to-parent questions with an answer path.
- Continue a child's conversation rather than rediscovering prior work in a new agent.
- MCP adapter and the operator's provider extensions must work inside children.
- Completion delivery should not require repetitive status polling or shell/file inspection.
- A compact live status widget remains visible near the main editor.
- The widget can collapse and expand, including clicking its visible summary.
- Arrow-key navigation can enter and move through child rows, comparable to the
  current nicobailon compact status UI. Preserve normal editor input outside that mode.
- Show useful identity/progress: role or name, model, state, and bounded current activity.
  Exact labels, placement, and key bindings are not settled.

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
- Workflow scripts are optional and low value for the usual one-to-three children.
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

Required: a role name, description, instruction body, and optional model/thinking.
Use the existing role files as use cases, not as a schema to copy wholesale.

Precedence is per-launch override > role default > current parent default.
Model selection must use Pi's actual available
catalog and disclose the effective model/thinking rather than silently substitute.

Initial implementation choices: append role instructions to the normal Pi prompt,
ignore legacy tool/skill restrictions, and keep model/thinking fixed for a child's
conversation. No mutable-defaults interface is added. These defaults can be adjusted
after the first implementation; see the implementation brief.

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

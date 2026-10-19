# Agent-facing surface audit

Date 2026-10-19, repository HEAD `884f36f`. This is a review, not an approved change list.
Nothing in `src/` was changed for it. Every change below needs the operator's decision.
Pinned source links and scope of inspection: [source map](../references/agent-surface-sources.md).

**Status 2026-10-19 (operator review).** Done in `13540b6` and `5bb7025`: F1 (saved-copy line without a
call to action), F2 (`<sidekick>` block), F5 with a reworded no-poll text, F6, F14; the "Do not delegate"
sentence (F8) was removed. Skipped: F13 (role bodies in dotfiles). Backlog: F3 (needs a paid Gemini run), F4.
F7, F9–F12 and the section 6 documentation proposals: no change. The text below is the original audit.

**Agent-facing** means any text or schema a model reads or any call a model makes: the parent's
`subagent` tool, the child's `ask_parent` tool, the child's briefing, labels on parent text, the
messages that carry results and questions back, error strings, and the agent definition files.
The widget and the `[sidekick]` renderers are for the human and are out of scope.

## Method and evidence levels

- **[measured]**: I ran the real extension under Pi 1.3.0 with a scripted provider and dumped the
  first request of a parent and of a child (system sections, tool declarations, messages).
  The script is `/tmp/sidekicks-audit/dump.ts` (scratch, not kept). No live model ran, so nothing here
  says how a real model behaves. Claims about behaviour are marked **[inferred]**.
- **[read]**: read in source or docs at the commits in [references/lock.json](../references/lock.json).
- Peers read: OpenCode v2 (`subagent` tool), OMP (oh-my-pi `task`), OmO (oh-my-openagent
  `senpi-task`; Senpi itself has no sub-agents), Codex (`multi_agents_spec.rs`, local clone, not pinned),
  and selected surfaces in all seven original pinned Pi references plus pi-subagentura. This is not
  a complete audit of those extensions. Claude Code itself was not inspected; similarity to
  tintinweb is not evidence of its current contract. Cursor, Grok and Gemini CLI were not read at prompt level.

## 1. What the models actually see [measured]

Parent request: Pi default sections plus our tool. `subagent` appears in `<tools>` through
`promptSnippet`; there are no `promptGuidelines`, so the tool description carries all guidance.

| Piece | Size | Where it comes from |
|---|---:|---|
| `subagent` description (static) | 1,317 chars | `src/index.ts` `DESCRIPTION` |
| `Agents:` list added by `prepareLoadout` | 637 chars in this fixture | three copied definitions, not the full operator list |
| `subagent` parameter schema | 2,907 chars | `src/index.ts`; batch fields are 1,264 (43%) |
| Child briefing (rendered `addendum` section) | 230 chars | `src/manager.ts` `CHILD_BRIEFING`; this fixture's worker body is empty |
| `ask_parent` description + schema | 288 + 142 chars | `src/child.ts` |

Child request, with an empty agent body and no `AGENTS.md`: a diagnostic concatenation of system
sections was 6,314 chars (not provider-wire size or a token count), made of
Pi's preamble ("You are an expert coding assistant …"), tool list, rules, a 1,373-char Pi docs
section, the addendum (agent body + briefing), 3,260 chars of skills, and `cwd`. First user
message is `Task:\n<task>`. `ask_parent` is **not** in the child's `<tools>` list (no
`promptSnippet`); the model knows it only from the tool declaration.

Messages back to the parent arrive as **user-role** messages:

```text
Sidekick worker asks (question ad4b8c46; blocking: it is paused until you answer):

Which option?

Reply with subagent {"action":"answer","child":"worker","questionId":"ad4b8c46","answer":"..."}.
```

The result example below is reconstructed from `deliveryText`, not a captured completion from that dump:

```text
Sidekick worker completed after 28s.

<child's final message, up to 24,000 chars>

Result file (the final answer only; read this, not the transcript): <path>
Transcript (the whole child session, large; read it only to audit the child's steps): <path>
```

Tool results are short plain text, for example
`Launched. Its result or questions arrive as messages; do not poll.` + `worker (worker, scripted:low) — running 0s: working`.

## 2. Comparison with peers [read]

| Element | Ours | Peers | Verdict |
|---|---|---|---|
| Tool shape | One tool, 15 fields: required `action` and 14 optional fields | Separate launch/control surfaces: OMP, OmO, Codex, williamcr01. OpenCode combines spawn/continue in `subagent`. nicobailon combines actions/workflows | Keep; see F9 |
| Launch is async | Always; no sync mode | OpenCode/OmO/tintinweb have a sync flag. OMP and williamcr01 async by default | Keep (scope) |
| "Do not poll" | Description + launch result | Same in OpenCode, tintinweb, nicobailon, OMP, williamcr01 | Good; see F5 |
| Wait/check tool | `status` exists; no blocking wait | OMP `wait`, Codex `wait_agent`, williamcr01 `check_subagents`; OmO `task_output` is nonblocking inspection, not a wait | Keep automatic delivery; a wait tool is not inherently polling |
| Result format | Plain header + body + path trailer | OpenCode `<subagent sessionID state>`, OMP `<task-result id agent status>`, tintinweb `<task-notification>` (XML-escaped), OmO `result:"…" result_file: next:` | Change; see F2 |
| File path in result | Always for a saved completed result | OmO spills long results (>32k); OMP links full output on truncation; tintinweb can include `output-file` regardless | Reword the instruction; see F1 |
| Continue hint | In question deliveries, not in result deliveries | OmO `next: Use task_send(...)`, OMP `idle — message it via …`, Codex "reuse via send_input", tintinweb "a new call has no memory", OpenCode `sessionID` | Change; see F4 |
| Child identity line | None | OmO: id, parent, depth; OMP: role + context; williamcr01: name + depth | Skip; the child needs none |
| Child "keep going" text | One sentence (result must stand alone) | OMP: "NEVER give up … keep going until this ticket is closed"; yield reminders | Skip without evidence of premature stops here |
| Child question tool | `ask_parent`, blocking by default | nicobailon `contact_supervisor`, purboo `ask`; no equivalent dedicated child-to-parent question tool established in the inspected OpenCode/OMP/OmO surfaces | Keep; our own scope item |
| `model`/`thinking` guard | Not in the schema; in the operator's `APPEND_SYSTEM` | Codex v2, OpenCode v2: "do not set unless the user asks" in the schema | Keep; see F11 |
| When-not-to-use, "verify claims", "brief like a colleague" | Only self-contained task guidance | tintinweb has explicit verification/briefing rules; OmO's OpenCode edition requires six sections; OMP recommends `# Target/# Change/# Acceptance` | Consider compact verification guidance; do not import an orchestrator workflow |
| Available agents in description | Yes, refreshed only on session start | OpenCode refreshes on every context/compaction hook; nicobailon pins declarations across resume (#2852) | Keep |
| Isolation (worktree) | None; `cwd` per launch | OMP/OmO/tintinweb worktree flag. OmO has no `cwd` | Keep (scope) |

Sizes for scale: OMP `task.md` 3,013 bytes (template with conditionals), tintinweb full description
4,621 chars (compact 1,210), OpenCode v2 description 597 chars. Ours is 1,317 + 2,907 schema.
These are not token counts or like-for-like totals: templates are not expanded and peer schemas are
not included. In our measured declaration the schema is larger than the description.

## 3. Findings

Severity is my estimate of the effect on agent behaviour. No behaviour was evaluated with a live
model. F13's missing child instruction and F14's invalid JSON were reproduced locally; the other
findings are design/wording assessments, not demonstrated model failures.

### F1 [P2] The result trailer tells the model to read a file whose text it already has

`deliveryText` (`src/present.ts`) adds `Result file (the final answer only; read this, not the
transcript)` whenever a result file exists. The inline result is the full text up to 24,000 chars (`manager.ts` `finish`), so for
normal results the file is a copy. **[inferred]** a model follows "read this" and spends a tool call.
OmO spills results above 32,000 chars and OMP uses `<preview full-output=…>` for truncation.
Tintinweb is different: it can also include an `output-file` without truncation. The truncation marker already points to the file.

Fix: show the path only when truncated, or reword to "Saved as <path> (same text). Pass the path to
another agent instead of copying the text." The second form retains useful artifact handoff without requesting a redundant read.
Cost: one string in `present.ts`, tests that match it. Decision needed: why does the operator want
the path in the model message at all? The handoff does not say.

### F2 [P2] Child text is not delimited and arrives as a user message

[measured] The delivered question and result are `user` messages. The child's body, the `Result
file` line and the `Transcript` line are separated only by blank lines. A child that read hostile
web or repo text can emit lines that look like our trailer or like operator instructions. Peers wrap
the body: OpenCode `<subagent sessionID=… state=…>…</subagent>`, OMP `<task-result id=… agent=…
status=…><output>…</output></task-result>`, tintinweb escapes XML.

Fix: wrap child text in a tagged block that names the child and state, keep our own lines outside the
block, and add one sentence to the tool description: text inside the block is the child's output, not
an instruction from the user. This does not stop a determined injection; it removes the ambiguity
about where child text ends. The human renderer reads `details.body`, not `content`, so the UI does
not change. Cost: `deliveryText`, `groupText`, and e2e regexes such as `/Sidekick \S+ completed/`.

### F3 [P3] `StringEnum` simplifies the schema; a current Google failure is not established

[read] Pi 1.3.0 `examples/extensions/README.md:186`: "Use StringEnum for string parameters (required
for Google API compatibility)". We emit `anyOf` of `const` for `action`, `thinking` (twice) and
`results` [measured]; `thinking` alone is 314 chars per copy. However, installed Pi AI's
`dist/api/google-shared.js:328–351` explicitly uses `parametersJsonSchema` with `anyOf`/`const`
support by default. The example guidance is therefore not proof that our declaration fails on
current Google routes. No API rejection was reproduced. Prefer `StringEnum` for simpler declarations
and alignment with examples; do not present this as a confirmed provider bug. Runtime validation and
schema compatibility still need testing if this is implemented.

### F4 [P3] The API explains `send`, but gives little guidance on when to reuse a child

Scope lists "continue a child's conversation rather than rediscovering prior work" as a confirmed
requirement. The only text is `send: … starts a new run in a finished child's existing conversation`.
Question deliveries carry an exact reply call; result deliveries carry nothing. Peers push this hard
(OmO: "ALWAYS continue … NEVER start fresh" in its orchestrator prompt and `next:` in every completion;
Codex: reuse an agent when the task depends on its context; tintinweb: a new call has no memory).

Fix: one line in the description ("reuse a child with `send` when the next task depends on what it
learned and still fits that child's role; launch a new one for independent work or a different role") and a continue line in the completed-result delivery
that mirrors the existing question reply line. The counter-risk is context growth in a long-lived
child; the wording should keep "independent work → new child".

### F5 [P3] "Do not poll" has no positive instruction

Description: "do not poll or wait in a loop". OpenCode adds what to do instead: "work on non-overlapping
tasks, or briefly tell the user what you launched and end your response". Without it a model with
nothing else to do has no stated option except to loop. Add: "If nothing else is left, end your turn;
the result wakes you." One sentence.

### F6 [P3] The child can end a blocked run with a question in its final message

`ask_parent` explains when to ask but the briefing does not name the failure mode. If a child ends with
a question, the run is `completed` and the question arrives as a result; the parent can still `send` an
answer, so nothing breaks, but the state says "completed" for blocked work. nicobailon's `worker.md`
and OMP both forbid ending on a question. Add to the briefing: "If you are blocked, call `ask_parent`;
do not end your final message with a question." About 90 chars.

### F7 [P3, decide] Operator definitions are written for `systemPromptMode: replace`; we ignore it

[read] Four of six operator definitions (`explorer`, `reviewer`, `researcher`, `e2e-verifier`) set
`replace`; `explorer` also sets `inheritSkills: false`. Children get Pi's "expert coding assistant"
preamble, the 1,373-char docs section and all skills, with the role body appended after. Read-only
roles (`explorer`, `reviewer`) are read-only only by prose; the child has `edit`, `write` and `bash`.
README and scope document this as an assistant choice ("append-only", "ignore legacy tool/skill
restrictions"), not an operator requirement.

[read] Pi 1.3 has the flags: `--system-prompt` (with it, `buildSystemPromptSections` keeps addendum,
project context, skills and `cwd`, and drops tools/rules/docs), `--tools` (allowlist), `--no-skills`.
Honouring `replace` needs a defined prompt composition contract and tests, not just a flag change:
normal tool rules/docs would also disappear. I found no evidence of harm, only a mismatch
between how the roles were written and how they run. Skill filtering was explicitly unwanted, so only
`replace` and `tools` are candidates. Recommendation: do nothing until a live run shows an identity
conflict or an unwanted write by a read-only role.

### F8 [P3] "Do not delegate to other agents" names a tool the child cannot see

`src/index.ts:50` returns early in a child, so `subagent` is absent. The sentence only matters for
other extensions' delegation tools. Neutral; keep or drop with F6 when editing the briefing.

### F9 [P3, record] One action-union tool versus one tool per verb

Nine of the fifteen schema fields apply to `launch` only. Several descriptions repeat that action prefix.
`execute` already rejects wrong-action fields with a message that lists the allowed ones
(`index.ts`, `fields`), which is the same remedy OmO builds as "retry guidance". No evidence of
wrong-field calls exists because no live run was logged. Keep. Record as a decision with the revisit
trigger "logged calls show wrong-field errors". `docs/architecture.md` still says "tool count remain open", but explicitly labels itself historical;
this is discoverability debt, not a conflicting current contract.

### F10 [P3, record] Batch costs 43% of the schema in every parent request

1,264 of 2,907 chars. Pi already runs parallel tool calls from one assistant message
(`docs/extensions.md:124`), so concurrency does not need `tasks`; the unique value is grouped
delivery (one wake instead of N). The operator agreed the feature. Keep; record the cost and the
reason so the choice can be revisited with real usage numbers.

### F11 [info] Delegation policy and `model` guards live only in the operator's prompt

`APPEND_SYSTEM.sidekicks.md` has "Set optional subagent controls only when explicitly requested …".
Codex v2 and OpenCode v2 put the equivalent in the `model` parameter text; nicobailon puts an
authorization rule in the description. Our scope audit removed such a rule from the description on
purpose (it was the operator's coding-agent policy, not product behaviour). That stays correct for a
personal tool, but the extension then depends on a file in dotfiles. Verified present today.

### F12 [info] Declaration stability

The description changes only on session start or `/reload` (documented). nicobailon goes further and
pins the recorded declaration across resume. A resumed session with edited definitions may get a
declaration change here. Its prompt-cache effect is provider-specific and was not measured. Acceptable;
no new persistence/pinning machinery is justified by this audit.

### F13 [P2] Some role constraints reach the parent, but not the child

`discoverAgents` separates frontmatter `description` from the Markdown body. `prepareLoadout` exposes
that description to the parent; `manager.open` appends only the body plus `CHILD_BRIEFING` in the child.
The operator's `explorer` description says "read-only", but its body contains only a search identity
and an output format. The `reviewer` description also says "read-only", but its body asks for adversarial
findings without that restriction. Neither description is passed to its child. This is not merely the
lack of a tool allowlist (F7): even the behavioural instruction is missing at the receiving boundary.
OpenCode's explore role explicitly forbids mutations in its role prompt; tintinweb also puts its
read-only instruction in the role body.

Recommendation: put operative role constraints in the role body, and keep the description as the
parent's selection/briefing guide. For example, both explorer and reviewer should explicitly prohibit
changing the target. This is a dotfiles change, not a reason to append all descriptions automatically:
they also contain caller instructions such as "Pass the goal …", which address the parent. No unwanted
write was observed. Fix the two definitions after approval, without adding a new policy framework.

### F14 [P3] Generated answer-call examples do not escape the child's name

`deliveryText` inserts `child.name` directly inside a JSON example. Explicit names are arbitrary strings
up to 100 characters; `uniqueName` checks uniqueness, not JSON syntax. With a name `review"one`, the
suggested call contains `"child":"review"one"` and is invalid JSON. Use `JSON.stringify` to construct
the example instead of restricting useful names. This is a deterministic formatting defect, not
model speculation. It also matters if F2 introduces attributes: arbitrary names and closing tags must
be escaped; a tagged block alone is not a security boundary.

### Peer-specific takeaways

- **OpenCode v2:** compact spawn/continue surface, fresh-context warning, useful positive instruction
  after background launch, and a clear result envelope. Its provider-specific system prompts disagree
  about proactive delegation (`gpt*.txt` requires authorization; `meta.txt` encourages it). Do not
  import one as a universal policy.
- **OMP:** lifecycle guidance is explicit (`completed` means the agent yielded; artifacts are unverified).
  Its structured-output, peer coordination, nested-job and yield-reminder machinery solves additional
  problems. Copying it would expand our product rather than improve the existing contract.
- **OmO/Senpi:** compare `packages/senpi-task`, not the older `omo-opencode` prompt as if they were one
  runtime. `task_send`/`next:` make continuation discoverable; categories, fallback routing, teams and
  canonical plan-review prompts carry policy we did not request. Senpi's base README itself says no sub-agents.
- **nicobailon:** narrow default descriptions plus discoverable guides are reasonable for its large
  surface. Our surface needs no guide tool. Its worker prompt puts scope authority, escalation and
  final-report requirements in the child, where they can affect behaviour.
- **tintinweb:** good self-contained handoff and verification guidance, but a much broader configurable
  runtime. Its output paths are not limited to truncation. Read-only policy appears in role prompts.
- **williamcr01:** small appended child briefing; background launch, continuation and wait/check are
  distinct concepts. Its mandatory wait guidance belongs to its delivery contract, not ours.
- **pi-subagentura:** interactive tool descriptions clearly distinguish attachable sessions from SDK
  children. Its thin-router mode reuses only the exact responsibility, never a shared domain word;
  in particular, a read-only audit child must not silently become an implementer. Useful principle
  for F4: reuse context only when role and scope still fit. Its immutable `(childId, turnId)` artifact
  references avoid reading a later result by mistake, but force extra fetches and identity handling.
  Its long responsibility ledger/confirmation rules and artifact `done` protocol are not needed by
  our direct parent–child API.
- **championswimmer:** `agent_pause` explicitly separates a paused child from final handback;
  `agent_update` is visible progress without waking the parent. Good semantic separation, but its
  many verbs, report-only timeout re-arming and caller-relative tree paths would add concepts to ours.
- **mavam:** `delegate` describes a parallel dependency graph, forwarding predecessor results to
  successors and returning terminal helper outputs. Useful if workflows become a requirement; its
  synchronous graph/replay contract is not a substitute for our retained, steerable conversations.
- **badlogic:** CLI verbs (`spawn`, `send`, `wait`, `stop`, `list`) and attachable tmux children show
  that a tiny interface is possible without a large orchestration prompt. CLI/shell discovery and
  process control move responsibilities out of typed model tools; not a drop-in contract for ours.
- **purboo:** explicit `ask` and schema-validated `report` tools show another completion contract.
  Adopting `report` would replace final-text completion and add schema/termination responsibilities;
  there is no demonstrated requirement for that change here.

## 4. What to keep

- Launch result "Its result or questions arrive as messages; do not poll" at the point of use, as OpenCode does.
- Question delivery with the exact reply call. It is the pattern F4 asks to reuse.
- Actionable errors: `Unknown agent. Available: …`, `Unknown child … Known: …`, `X does not take … It takes: …`.
- Short briefing. OMP's long child prompt also serves structured yields, nested jobs and peer messaging;
  those features are not ours. No evidence justifies importing that whole prompt.
- Automatic completion delivery. A blocking wait is not a polling loop, but no concrete need for one
  was established here.
- Label guard (`Task:`, `Guidance:`, `Follow-up:`, `Answer to <id>:`): needed because Pi runs a leading `/` as a command.

## 5. Suggested order

1. F13: correct the role bodies so read-only constraints reach the child (operator dotfiles).
2. F1, F2, F14: clarify result provenance/file guidance and generate valid reply examples.
3. F3–F6: optional schema/wording cleanup; no confirmed live-model bug.
4. F7: keep append semantics for now; do not restore legacy settings merely because they exist.
5. F8–F12: record the trade-offs; no machinery added.

Fragility: every wording change is unverified against a live model. The scripted provider proves the
text is delivered, not that a model reacts to it. A cheap check is one live session per change with a
real parent, looking for the extra file read (F1) and for `send` versus `launch` (F4).

## 6. Documentation review

Observed problems:

- `docs/scope.md:105` links `../handoff-v1-corrections.md`, which was deleted. The provenance claim
  now points at nothing.
- Several reasons already exist in tracked docs: label prefixes, the `cwd` usage observation,
  compatibility env names and scan-once are in `scope.md` or `implementation-brief.md`. Do not
  duplicate them as supposedly new ADR discoveries. The handoff remains a useful index, not the sole
  source. Any evidence surviving only in operator session artifacts needs a durable citation.
- The main decision log is the constraints table in `scope.md`. It usefully distinguishes operator
  requirements from assistant choices, but mixes several decisions into long rows. Alternatives and
  revisit conditions are inconsistent.
- `docs/architecture.md` is explicitly historical and points to the current brief. Its old open-decision
  list and Pi 1.2 observations are not bugs, but moving it under an archive would reduce reading cost.
- `docs/implementation-brief.md` states "105 tests"; the suite has 106. Counts and hashes go stale.
- There is no document of the agent-facing contract itself. The exact model-visible text lives in
  `src/index.ts`, `src/manager.ts`, `src/present.ts`, and `src/child.ts`.

Proposal (needs approval before writing):

1. Start with four short decision records, not one file for every constant:
   - parent API: action union, asynchronous delivery, batch grouping and continuation;
   - child context: fresh conversation, normal Pi discovery, appended role body, no nested delegation;
   - question/result contract: final-text completion, blocking/nonblocking questions, provenance and files;
   - lifecycle boundaries: stop versus destroy, persisted conversation, no automatic mutation replay.
   Each needs Status, Context, Decision, Alternatives with pinned links, Consequences, Revisit when,
   and Provenance (operator or assistant). Do not mark these new recommendations as accepted decisions.
2. Add the contract map to the existing implementation brief, rather than maintain a second full
   `agent-surface.md` that would duplicate it. Keep exact text in source; docs describe semantics.
3. Keep confirmed requirements in `scope.md`; link detailed rationale to those records without losing
   operator-versus-assistant provenance. Repair the deleted handoff link using a durable reference.
4. Leave a clear archive heading in `architecture.md`/`research.md`, or move them only if that reduces
   onboarding work. Their current historical disclaimer is already correct.
5. Replace counted facts ("105 tests") with verification commands or a dated result. Do not maintain
   duplicate hand-copied counts. Keep herdr-specific rationale near its integration, not as another
   general agent-contract ADR.

Not done: no ADR files, no rewrite of existing docs, no commit.

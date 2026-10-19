import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agents.ts";
import type { ChildSnapshot, Question, Run, RunState } from "./manager.ts";

export type Style = Pick<Theme, "fg" | "bold">;
export const plainStyle: Style = { fg: (_color, text) => text, bold: (text) => text };

/** Child output is untrusted: keep terminal control characters out of anything we draw. */
export const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

type Tone = "accent" | "success" | "error" | "warning" | "muted";
const STATES: Record<RunState, { glyph: string; tone: Tone; word: string }> = {
  starting: { glyph: "◌", tone: "accent", word: "starting" },
  running: { glyph: "●", tone: "accent", word: "running" },
  waiting: { glyph: "?", tone: "warning", word: "waiting" },
  completed: { glyph: "✓", tone: "success", word: "completed" },
  failed: { glyph: "✗", tone: "error", word: "failed" },
  cancelled: { glyph: "■", tone: "muted", word: "stopped" },
  interrupted: { glyph: "!", tone: "warning", word: "interrupted" },
};
export const stateGlyph = (style: Style, state: RunState) => style.fg(STATES[state].tone, STATES[state].glyph);
export const stateWord = (style: Style, state: RunState) => style.fg(STATES[state].tone, STATES[state].word);
export const stateTone = (state: RunState): Tone => STATES[state].tone;
export const isActive = (state: RunState) => state === "starting" || state === "running" || state === "waiting";

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
// Runs that finished before endedAt was recorded have no end to measure to.
export const elapsedOf = (run: Run, now = Date.now()) =>
  run.startedAt === undefined || (run.endedAt === undefined && !isActive(run.state)) ? undefined : formatElapsed((run.endedAt ?? now) - run.startedAt);

/** Provider prefix is noise in a row; the full id stays in snapshots and transcripts. */
export const modelLabel = (child: Pick<ChildSnapshot, "model" | "thinking">) => `${child.model.split("/").pop()}:${child.thinking}`;

export function summary(style: Style, children: ChildSnapshot[]): string {
  const count = (states: RunState[]) => children.filter((child) => !child.external && states.includes(child.run.state)).length;
  const parts: [RunState, number, string][] = [["running", count(["starting", "running"]), "running"],
    ["waiting", count(["waiting"]), "waiting"], ["failed", count(["failed", "interrupted"]), "failed"],
    ["completed", count(["completed"]), "done"], ["cancelled", count(["cancelled"]), "stopped"]];
  const labels = parts.filter(([, n]) => n > 0).map(([state, n, word]) => `${stateGlyph(style, state)} ${style.fg(STATES[state].tone, `${n} ${word}`)}`);
  const external = children.filter((child) => child.external).length;
  if (external) labels.push(style.fg("muted", `${external} in another window`));
  return labels.join(style.fg("dim", " · "));
}

const preview = (text: string, length: number) => {
  const line = plain(text).replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** One line the model can scan: handle first, because it is the argument of every follow-up call. */
export function describeChild(child: ChildSnapshot): string {
  const run = child.run;
  if (child.external) return `${child.name} (${child.agent}, ${modelLabel(child)}) — managed by another window; saved status: ${STATES[run.state].word}${run.resultFile ? ` (result file: ${run.resultFile})` : ""}. send/answer/stop are unavailable while it owns the child.`;
  const detail = run.question ? `asks ${run.question.id}: ${preview(run.question.text, 160)}`
    : isActive(run.state) ? child.connected ? child.activity : "detached" : preview(run.result ?? "", 160);
  const questions = child.questions?.length ? `; ${child.questions.length} open non-blocking question(s): ${child.questions.map((q) => q.id).join(", ")}` : "";
  const file = !isActive(run.state) && run.resultFile ? ` (result file: ${run.resultFile})` : "";
  const measurement = progress(child);
  return `${child.name} (${child.agent}, ${modelLabel(child)}${child.cwd ? `, cwd ${child.cwd}` : ""}) — ${STATES[run.state].word}${elapsedOf(run) ? ` ${elapsedOf(run)}` : ""}${measurement ? ` · ${measurement}` : ""}${detail ? `: ${detail}` : ""}${file}${questions}`;
}

/** Raw numbers, because the parent model compares them and the widget owns its own formatting. */
function progress(child: ChildSnapshot): string {
  const usage = child.contextUsage;
  return [child.run.turns === undefined ? "" : `${child.run.turns} turns`,
    child.run.tools === undefined ? "" : `${child.run.tools} tools`,
    usage ? `ctx ${usage.tokens ?? "unknown"}/${usage.contextWindow}` : ""].filter(Boolean).join(" · ");
}

export function statusText(children: ChildSnapshot[], agents: Agent[]): string {
  const lines = [children.length ? `Children:\n${children.map((child) => `- ${describeChild(child)}`).join("\n")}` : "No children yet."];
  lines.push(`Agents: ${agents.map((agent) => agent.name).join(", ") || "none"}`);
  return lines.join("\n");
}

export function groupHeadline(members: { state: RunState }[]): string {
  const counts = new Map<RunState, number>();
  for (const member of members) counts.set(member.state, (counts.get(member.state) ?? 0) + 1);
  return [`batch of ${members.length}`, ...[...counts].map(([state, count]) => `${count} ${STATES[state].word}`)].join(" · ");
}

export function groupText(members: ChildSnapshot[]): string {
  return [groupHeadline(members.map((child) => ({ state: child.run.state }))),
    ...members.map((child) => child.run.state === "completed" && !child.run.delivered
      ? deliveryText(child, "result")
      : `Sidekick ${child.name} ${STATES[child.run.state].word}${child.run.state === "failed" || child.run.state === "interrupted" ? " (already reported)" : ""}.`)].join("\n\n");
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Child text may contain our own closing tag; neutralise any sidekick tag so it cannot end the block early. */
const block = (child: ChildSnapshot, text: string) =>
  `<sidekick name="${escapeAttribute(child.name)}" state="${child.run.state}">\n${text.replace(/<(\/?sidekick)/gi, "&lt;$1")}\n</sidekick>`;

/** What the parent model reads when a child finishes or asks. The human sees a rendered version of the same message. */
export function deliveryText(child: ChildSnapshot, kind: "question" | "result", question?: Question, blocking?: boolean): string {
  if (kind === "question") {
    return [`Sidekick ${child.name} asks (question ${question!.id}; ${blocking ? "blocking: it is paused until you answer" : "non-blocking: it keeps working"}):`,
      "", block(child, question!.text), "",
      `Reply with subagent ${JSON.stringify({ action: "answer", child: child.name, questionId: question!.id, answer: "..." })}.`].join("\n");
  }
  const elapsed = elapsedOf(child.run);
  return [`Sidekick ${child.name} ${STATES[child.run.state].word}${elapsed ? ` after ${elapsed}` : ""}.`, "",
    block(child, child.run.result ?? "(no result)"), "",
    ...(child.run.resultFile ? [`Saved copy of the text above: ${child.run.resultFile}`] : []),
    `Full session transcript: ${child.sessionPath}`].join("\n");
}

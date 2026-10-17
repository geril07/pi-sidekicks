import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { describeTool, type ChildSnapshot } from "../src/manager.ts";
import { deliveryText, describeChild, formatElapsed, statusText } from "../src/present.ts";
import { renderCall, renderDelivery, renderResult, type DeliveryDetails } from "../src/render.ts";

const child: ChildSnapshot = { id: "uuid", name: "explorer-1", agent: "explorer", model: "openai/gpt-6", thinking: "high",
  run: { id: "run", state: "running", delivered: false, startedAt: Date.now() - 12_000 }, connected: true, activity: "read src/a.ts", sessionPath: "/c.jsonl" };
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const lines = (component: Component, width = 100) => component.render(width).map((line) => stripTerminalSequences(line).trimEnd()).filter(Boolean);

test("tool activity is a bounded one-line label", () => {
  assert.equal(describeTool("read", { path: "src/a.ts" }), "read src/a.ts");
  assert.equal(describeTool("bash", { command: "echo\n  hi" }), "bash echo hi");
  assert.equal(describeTool("effect", {}), "effect");
  assert.equal(describeTool("bash", { command: "x".repeat(500) }).length, 160);
  assert.equal(formatElapsed(3_600_000 + 120_000), "1h02m");
  assert.equal(formatElapsed(185_000), "3m05s");
});

test("model-facing text names the child and tells the parent how to reply", () => {
  assert.match(describeChild(child), /^explorer-1 \(explorer, gpt-6:high\) — running 1\ds: read src\/a\.ts$/);
  const question = deliveryText(child, "question", { id: "ab12cd34", text: "Which option?" }, true);
  assert.match(question, /explorer-1 asks \(question ab12cd34; blocking/);
  assert.match(question, /"child":"explorer-1","questionId":"ab12cd34"/);
  const done = { ...child, run: { ...child.run, state: "completed" as const, endedAt: Date.now(), result: "Found it." } };
  const result = deliveryText(done, "result");
  assert.match(result, /^Sidekick explorer-1 completed after 12s\./);
  assert.match(result, /Found it\./);
  assert.doesNotMatch(result, /"runId"|childId/, "no JSON bookkeeping in the model-facing text");
  assert.match(statusText([child], [{ name: "explorer", description: "d", instructions: "" }]), /Children:\n- explorer-1.*\nAgents: explorer/);
});

test("transcript renderers show status, bounded previews, and sanitized text", () => {
  const body = ["one", "two", "three", "four", "five\x1b]52;x\x07"].join("\n");
  const details: DeliveryDetails = { kind: "result", child: "explorer-1", state: "completed", elapsed: "12s", body };
  const collapsed = lines(renderDelivery({ details }, { expanded: false }, theme)!);
  assert.match(collapsed[0], /\[sidekick\] explorer-1 completed · 12s/);
  assert(collapsed.some((line) => line.includes("three")));
  assert(!collapsed.some((line) => line.includes("four")), "collapsed preview is bounded");
  assert(collapsed.some((line) => /2 more lines/.test(line)));
  assert(lines(renderDelivery({ details }, { expanded: true }, theme)!).some((line) => line.includes("five")));
  assert(!lines(renderDelivery({ details }, { expanded: true }, theme)!).join("").includes("\x07"));
  const asks = lines(renderDelivery({ details: { kind: "question", child: "worker", state: "waiting", blocking: true, questionId: "q", body: "Which?" } }, { expanded: false }, theme)!);
  assert.match(asks[0], /\[sidekick\] worker asks · paused/);
  assert.equal(renderDelivery({}, { expanded: false }, theme), undefined);

  assert.match(lines(renderCall({ action: "launch", agent: "explorer", name: "scan", task: "Find\nthe thing" }, theme))[0], /subagent launch explorer as scan\s+Find the thing/);
  assert.match(lines(renderCall({ action: "send", child: "scan", message: "Also check tests" }, theme))[0], /subagent send scan\s+Also check tests/);
  const result = { content: [{ type: "text", text: "ignored" }], details: { action: "launch", child } };
  assert.match(lines(renderResult(result, { expanded: false }, theme, false) as Component)[0], /● explorer-1 explorer gpt-6:high running · 12s/);
  assert.match(lines(renderResult({ content: [{ type: "text", text: "Unknown child: x" }] }, { expanded: false }, theme, true))[0], /Unknown child: x/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ChildSnapshot } from "../src/manager.ts";
import { renderCall, renderResult, type ToolDetails } from "../src/render.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const child = (name: string, state: ChildSnapshot["run"]["state"] = "running"): ChildSnapshot => ({ id: name, name, agent: "worker", model: "openai/gpt-6", thinking: "high",
  run: { id: `run-${name}`, number: 1, state, delivered: false, startedAt: Date.now() - 53_000, ...(state === "running" ? {} : { endedAt: Date.now() }) }, connected: true, activity: "", sessionPath: "/c.jsonl" });
const screen = (component: Component, width = 100) => component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
const result = (details: ToolDetails) => ({ content: [{ type: "text", text: "model-facing text" }], details });
const draw = (details: ToolDetails, args: Record<string, unknown>, expanded = false, width = 100, isError = false) =>
  screen(renderResult(result(details), { expanded }, theme, { args, isError }), width);

test.before(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync("/tmp/opencode/sidekicks-render-");
  initTheme("dark", false);
});

test("the call line names the target and never carries the prompt", () => {
  const call = (args: Record<string, unknown>) => screen(renderCall(args, theme))[0];
  assert.equal(call({ action: "launch", agent: "explorer", name: "scan", task: "SECRET-PROMPT" }), "subagent launch explorer as scan");
  assert.equal(call({ action: "send", child: "scan", message: "SECRET-PROMPT" }), "subagent send scan");
  assert.equal(call({ action: "answer", child: "scan", questionId: "q", answer: "SECRET-PROMPT" }), "subagent answer scan");
  assert.equal(call({ action: "launch", tasks: [{ task: "SECRET-PROMPT" }, {}] }), "subagent launch batch of 2");
});

test("a live child row has no state word, glyph, or time that could go stale; a final state is shown", () => {
  for (const action of ["launch", "send", "answer"]) {
    const [row, ...rest] = draw({ action, child: child("scan") }, { action, task: "Do it" });
    assert.equal(row, "scan worker gpt-6:high");
    assert(!/running|starting|waiting|53s|●/.test(row));
    assert.deepEqual(rest, ["Do it"]);
  }
  assert.equal(draw({ action: "stop", child: child("scan", "cancelled") }, { action: "stop", child: "scan" }).join("\n"), "scan worker gpt-6:high stopped");
  assert.match(draw({ action: "send", child: { ...child("scan", "completed") } }, { action: "send", message: "again" })[0], /scan worker gpt-6:high completed$/);
  assert.equal(draw({ action: "launch", child: { ...child("worker") } }, { action: "launch", task: "x" })[0], "worker gpt-6:high", "agent is hidden when equal to the name");
});

test("a collapsed prompt is three wrapped rows, even for one long paragraph, with a hint that counts the hidden rows", () => {
  const paragraph = "word ".repeat(200).trim();
  const details = { action: "launch", child: child("scan") };
  const args = { action: "launch", task: paragraph };
  const narrow = draw(details, args, false, 40);
  assert.equal(narrow.length, 1 + 3 + 1);
  assert.match(narrow[4], /^… (\d+) more lines \(.+ to expand\)$/);
  const hidden = Number(narrow[4].match(/^… (\d+)/)![1]);
  const full = draw(details, args, true, 40).slice(1).filter(Boolean);
  assert.equal(hidden, full.length - 3, "the count matches what expanding reveals");
  assert.equal(full.join(" ").split(/\s+/).join(" "), paragraph, "expanded shows the whole text");
  for (const width of [1, 10, 30, 100]) for (const expanded of [false, true]) {
    for (const line of renderResult(result(details), { expanded }, theme, { args, isError: false }).render(width)) assert(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test("a prompt that fits in three rows has no hint, and an expanded prompt is Markdown", () => {
  const args = { action: "send", message: "one\ntwo\nthree" };
  const rows = draw({ action: "send", child: child("scan") }, args);
  assert.deepEqual(rows, ["scan worker gpt-6:high", "one", "two", "three"]);
  const expanded = draw({ action: "send", child: child("scan") }, { action: "send", message: "**bold** text" }, true);
  assert.deepEqual(expanded, ["scan worker gpt-6:high", "bold text"]);
});

test("an error keeps its text and shows the prompt below it", () => {
  const rows = screen(renderResult({ content: [{ type: "text", text: "Unknown agent. Available: worker" }] }, { expanded: false }, theme, { args: { action: "launch", task: "Do the thing" }, isError: true }));
  assert.deepEqual(rows, ["Unknown agent. Available: worker", "Do the thing"]);
});

test("status keeps its summary and its expanded rows with state and elapsed time", () => {
  const children = [child("one"), child("two", "completed")];
  assert.match(draw({ action: "status", children }, { action: "status" }).join("\n"), /● 1 running · ✓ 1 done/);
  const expanded = draw({ action: "status", children }, { action: "status" }, true);
  assert.match(expanded[0], /^● one worker gpt-6:high running · 5\ds$/);
  assert.match(expanded[1], /^✓ two worker gpt-6:high completed/);
});

test("a batch lists members and a startup failure when collapsed, and each full prompt when expanded", () => {
  const outcomes = [{ child: child("one") }, { child: child("two", "failed"), error: "\n  spawn failed: ENOENT\nstack" }];
  const details = { action: "launch", children: outcomes.map((o) => o.child), outcomes };
  const args = { action: "launch", shared: "SHARED CONTEXT", tasks: [{ agent: "worker", task: "First task\nsecond line\nthird\nfourth" }, { agent: "worker", task: "Second task" }] };
  const collapsed = draw(details, args);
  assert.deepEqual(collapsed.slice(0, 3), ["one worker gpt-6:high", "two worker gpt-6:high failed", "startup failed: spawn failed: ENOENT"]);
  assert.match(collapsed[3], /to expand$/);
  assert.equal(collapsed.length, 4);
  assert(!collapsed.join("\n").includes("First task"));
  const expanded = draw(details, args, true).join("\n");
  for (const text of ["SHARED CONTEXT", "First task", "fourth", "Second task"]) assert(expanded.includes(text), text);
  assert.equal(expanded.match(/SHARED CONTEXT/g)!.length, 2, "each member gets the shared text");
  assert(expanded.indexOf("one worker") < expanded.indexOf("First task") && expanded.indexOf("First task") < expanded.indexOf("two worker"));
  assert(!expanded.includes("to expand"));
});

test("terminal control characters never reach the screen", () => {
  const evil = "\x1b]0;title\x07 \x1b[2J \x9b31m";
  const outcomes = [{ child: { ...child(`bad${evil}`), agent: `agent${evil}` }, error: `boom${evil}` }];
  const cases: [ToolDetails | undefined, Record<string, unknown>, boolean][] = [
    [{ action: "launch", child: { ...child(`bad${evil}`), agent: `agent${evil}` } }, { task: `task${evil}` }, false],
    [{ action: "launch", children: [outcomes[0].child], outcomes }, { shared: evil, tasks: [{ agent: "a", task: `task${evil}` }] }, false],
    [undefined, { task: `task${evil}` }, false],
  ];
  for (const [details, args, expanded] of cases) for (const open of [expanded, !expanded]) {
    const text = renderResult({ content: [{ type: "text", text: `error${evil}` }], details }, { expanded: open }, theme, { args, isError: !details }).render(80).join("\n");
    assert(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text.replaceAll("\n", "")), JSON.stringify(text));
  }
});

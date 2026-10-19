import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, visibleWidth, type TUI, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StatusWidget } from "../src/widget.ts";
import type { ChildSnapshot } from "../src/manager.ts";

const child = (id: string): ChildSnapshot => ({ id, name: `worker-${id}`, agent: "worker", model: "local/model", thinking: "low",
  run: { id: `run-${id}`, number: 1, state: "running", delivered: false, startedAt: Date.now() - 65_000 }, connected: true, activity: "read src/a.ts", sessionPath: `/store/child-${id}/session.jsonl` });

test("widget is hidden without children and summarizes states once they exist", () => {
  const children: ChildSnapshot[] = [];
  const widget = new StatusWidget(() => children);
  assert.deepEqual(widget.render(120), []);
  children.push(child("one"), child("two"));
  children[1].run = { ...children[1].run, state: "failed", endedAt: Date.now() };
  const [summary, ...rows] = widget.render(120);
  assert.match(summary, /1 running/);
  assert.match(summary, /1 failed/);
  assert.doesNotMatch(summary, /ctrl\+alt/);
  assert.deepEqual(rows, []);
  children.length = 0;
  assert.deepEqual(widget.render(120), []);
});

test("rows show name, agent, model, state and elapsed time; a failure keeps its reason; Enter shows only the storage folder", () => {
  const children = [child("one"), child("two"), child("three")];
  children[0].name = "名字".repeat(40) + "\x1b]52;bad\x07";
  children[0].run = { ...children[0].run, question: { id: "q1", text: "which database?" } };
  children[1].run = { ...children[1].run, state: "completed", result: "line one\nline two", endedAt: Date.now() - 1000 };
  children[2].run = { ...children[2].run, state: "failed", result: "\nboom: provider refused\nmore", endedAt: Date.now() - 2000 };
  const widget = new StatusWidget(() => children);
  assert.equal(widget.render(80).length, 1);
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 0 } as TuiMouseEvent), { handled: true });
  const lines = widget.render(120);
  assert.equal(lines.length, 4);
  assert.match(lines[2], /worker-two/);
  assert.match(lines[2], /worker local\/model:low|model:low/);
  assert.match(lines[2], /completed/);
  assert.match(lines[1], /1m05s|1m0\ds/);
  assert.match(lines[3], /failed.*boom: provider refused/);
  for (const hidden of ["read src/a.ts", "which database?", "line one"]) assert(!lines.join("\n").includes(hidden), `${hidden} stays out of the rows`);
  for (const width of [1, 10, 40, 80]) {
    for (const line of widget.render(width)) { assert(visibleWidth(line) <= width); assert(!line.includes("\x1b]")); assert(!line.includes("\x07")); }
  }
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 2 } as TuiMouseEvent), { handled: true });
  const detailed = widget.render(120);
  assert.equal(detailed.length, 5, "one folder line");
  assert.match(detailed[3], /^\s+\/store\/child-\w+$/, "the row's own folder, not a shared one");
  assert(!detailed.join("\n").includes("line one"));
  widget.handleMouse({ type: "click", button: "left", y: 0 } as TuiMouseEvent);
  assert.equal(widget.render(120).length, 1);
});

test("each row shows turns, tools and current/max context on one line without spend or compactions", () => {
  const children = [child("one"), child("two"), child("three")];
  children[0].run = { ...children[0].run, turns: 5, tools: 12 };
  children[0].contextUsage = { tokens: 42000, contextWindow: 200000, percent: 21 };
  children[1].run = { ...children[1].run, turns: 0, tools: 0, state: "waiting" };
  children[1].contextUsage = { tokens: null, contextWindow: 200000, percent: null };
  children[2].run = { ...children[2].run, turns: 3, tools: 7, state: "completed", endedAt: Date.now() };
  children[2].contextUsage = { tokens: 25300, contextWindow: 200000, percent: 12.65 };
  const widget = new StatusWidget(() => children);
  widget.toggle();
  const rows = widget.render(140).slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /running\s+5 turns · 12 tools · ctx 42k\/200k\s+1m/);
  assert.match(rows[1], /waiting\s+0 turns · 0 tools · ctx —\/200k/);
  assert.match(rows[2], /completed\s+3 turns · 7 tools · ctx 25\.3k\/200k/);
  assert.doesNotMatch(rows.join("\n"), /tokens|\$|compaction|%/);
  children[0].contextUsage = { tokens: 0, contextWindow: 200000, percent: 0 };
  assert.match(widget.render(140)[1], /ctx 0\/200k/);
  children[0].contextUsage = undefined;
  assert.match(widget.render(140)[1], /ctx —\/—/);
});

test("live children come first in launch order, finished ones follow newest first, and ten rows fit before scrolling", () => {
  const at = (id: string, state: "running" | "waiting" | "completed" | "failed", ended?: number): ChildSnapshot => ({ ...child(id), name: id,
    run: { id: `run-${id}`, number: 1, state, delivered: false, startedAt: Date.now() - 100_000, ...(ended ? { endedAt: Date.now() - ended } : {}) } });
  const names = (lines: string[]) => lines.slice(1).map((line) => line.match(/\b(d\d+|a\d+|r\d+)\b/)?.[1]);
  const children = [at("d1", "completed", 5000), at("d2", "failed", 3000), at("d3", "completed", 9000),
    at("r1", "running"), at("a1", "waiting"), at("r2", "running")];
  const widget = new StatusWidget(() => children);
  widget.toggle();
  assert.deepEqual(names(widget.render(120)), ["r1", "a1", "r2", "d2", "d1", "d3"]);
  assert.deepEqual(children.map((c) => c.name), ["d1", "d2", "d3", "r1", "a1", "r2"], "the caller's list is not reordered");

  const ten = Array.from({ length: 10 }, (_, i) => at(`r${i}`, "running"));
  const tenWidget = new StatusWidget(() => ten);
  tenWidget.toggle();
  const lines = tenWidget.render(120);
  assert.equal(lines.length, 11);
  assert(!lines.join("\n").includes("more"));

  const twelve = [at("d0", "completed", 1000), at("d1", "completed", 2000), at("d2", "completed", 3000),
    ...Array.from({ length: 9 }, (_, i) => at(`r${i}`, "running"))];
  const long = new StatusWidget(() => twelve);
  long.toggle();
  const rendered = long.render(120);
  assert.deepEqual(names(rendered).slice(0, 10), ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "d0"]);
  assert.match(rendered.at(-1)!, /↓ 2 more/);

  long.selectedId = "d2";
  twelve[3] = { ...twelve[3], run: { ...twelve[3].run, state: "completed", endedAt: Date.now() } };
  assert.equal(long.selectedId, "d2", "the cursor stays on its child while rows reorder");
  assert.match(long.render(120).join("\n"), /↑ 2 more/);
});

test("down on an empty editor enters row selection; other input, drafts, and dialogs are untouched", async (t) => {
  const terminal: Terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start: (handler) => { input = handler; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  let input: (data: string) => void = () => {};
  const tui = new TuiMainScreen(terminal);
  t.after(() => tui.stop());
  const identity = (text: string) => text;
  const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
  const editor = new Editor(tui, theme);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  const children = [child("one"), child("two")];
  const widget = new StatusWidget(() => children);
  const ctx = { mode: "tui", ui: {
    setWidget: (_key: string, factory: (tui: TUI, theme: Theme) => Component) => { tui.addChild(factory(tui, { fg: (_c: string, text: string) => text, bold: identity } as unknown as Theme)); },
    onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => tui.addInputListener(handler),
    getEditorText: () => editor.getText(),
  } } as unknown as ExtensionContext;
  t.after(() => widget.dispose());
  widget.install(ctx);

  input("\x1b[B");
  assert(widget.focused && widget.expanded);
  assert.equal(widget.selectedId, "one");
  input("\x1b[B");
  assert.equal(widget.selectedId, "two");
  input("\r");
  assert.equal(widget.detailId, "two");
  input("\x1b[A");
  assert.equal(widget.selectedId, "one");
  assert.equal(widget.detailId, undefined);
  input("\x1b[A");
  assert(!widget.focused && !widget.expanded, "up from the first row closes the list");

  input("\x1b[B");
  input("\x1b");
  assert(!widget.focused && !widget.expanded);

  input("\x1b[B");
  input("x");
  assert(!widget.focused && !widget.expanded, "an unrelated key closes the list");
  assert.equal(editor.getText(), "x", "and still reaches the editor");

  editor.setText("draft");
  input("\x1b[B");
  assert.equal(widget.focused, false, "down is not stolen from a non-empty draft");

  editor.setText("");
  const dialog = new Editor(tui, theme);
  dialog.setText("prefill");
  tui.addChild(dialog);
  tui.setFocus(dialog);
  input("\x1b[B");
  assert.equal(widget.focused, false, "a focused dialog keeps its keys");
  tui.setFocus(editor);

  widget.suspend(true);
  input("\x1b[B");
  assert.equal(widget.focused, false, "suspended while a relayed dialog is open");
  widget.suspend(false);
  input("\x1b[B");
  assert.equal(widget.focused, true);
  widget.dispose();
  widget.dispose();
});

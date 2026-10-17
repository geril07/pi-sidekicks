import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, visibleWidth, type TUI, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StatusWidget } from "../src/widget.ts";
import type { ChildSnapshot } from "../src/manager.ts";

const child = (id: string): ChildSnapshot => ({ id, name: `worker-${id}`, agent: "worker", model: "local/model", thinking: "low",
  run: { id: `run-${id}`, state: "running", delivered: false, startedAt: Date.now() - 65_000 }, connected: true, activity: "read src/a.ts", sessionPath: `/child-${id}.jsonl` });

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

test("rows show name, model, state, bounded activity and elapsed time; clicks toggle and open details", () => {
  const children = [child("one"), child("two")];
  children[0].name = "名字".repeat(40) + "\x1b]52;bad\x07";
  children[1].run = { ...children[1].run, state: "completed", result: "line one\nline two", endedAt: Date.now() };
  const widget = new StatusWidget(() => children);
  assert.equal(widget.render(80).length, 1);
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 0 } as TuiMouseEvent), { handled: true });
  const lines = widget.render(120);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /worker-two/);
  assert.match(lines[2], /local\/model|model:low/);
  assert.match(lines[2], /completed/);
  assert.match(lines[1], /1m05s|1m0\ds/);
  for (const width of [1, 10, 40, 80]) {
    for (const line of widget.render(width)) { assert(visibleWidth(line) <= width); assert(!line.includes("\x1b]")); assert(!line.includes("\x07")); }
  }
  assert.deepEqual(widget.handleMouse({ type: "click", button: "left", y: 2 } as TuiMouseEvent), { handled: true });
  const detailed = widget.render(120).join("\n");
  assert.match(detailed, /line one/);
  assert.match(detailed, /child-two\.jsonl/);
  widget.handleMouse({ type: "click", button: "left", y: 0 } as TuiMouseEvent);
  assert.equal(widget.render(120).length, 1);
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
  assert.equal(widget.focused, false);
  assert.equal(widget.expanded, true, "leaving the first row keeps the list open");

  input("\x1b[B");
  input("\x1b");
  assert(!widget.focused && !widget.expanded);

  input("\x1b[B");
  input("x");
  assert.equal(widget.focused, false);
  assert.equal(editor.getText(), "x", "an unrelated key reaches the editor");

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

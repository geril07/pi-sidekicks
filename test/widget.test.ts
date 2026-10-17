import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, visibleWidth, type TUI, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { StatusWidget } from "../src/widget.ts";
import type { ChildSnapshot } from "../src/manager.ts";

const child = (id: string): ChildSnapshot => ({ id, name: `Worker ${id}`, agent: "worker", model: "local/model", thinking: "low",
  run: { id: `run-${id}`, state: "running", delivered: false }, connected: true, activity: "using read", sessionPath: `/child-${id}.jsonl` });

test("widget is hidden without children and remains available for existing conversations", () => {
  const children: ChildSnapshot[] = [];
  const widget = new StatusWidget(() => children);
  assert.deepEqual(widget.render(120), []);
  widget.toggle();
  assert.deepEqual(widget.render(120), []);
  children.push(child("one"));
  assert.match(widget.render(120)[0], /1 working/);
  children[0].run.state = "completed";
  assert.match(widget.render(120)[1], /completed/);
  children.length = 0;
  assert.deepEqual(widget.render(120), []);
});

test("widget bounds Unicode/activity, sanitizes terminal controls, and click does not request focus", () => {
  const children = [child("one"), child("two")];
  children[0].name = "名字".repeat(40) + "\x1b]52;bad\x07";
  const widget = new StatusWidget(() => children);
  assert.equal(widget.render(40).length, 1);
  const response = widget.handleMouse({ type: "click", button: "left", y: 0 } as TuiMouseEvent);
  assert.deepEqual(response, { handled: true });
  assert.equal(widget.render(40).length, 3);
  for (const width of [1, 10, 40, 80]) {
    for (const line of widget.render(width)) { assert(visibleWidth(line) <= width); assert(!line.includes("\x1b]")); assert(!line.includes("\x07")); }
  }
  widget.selectedId = "two";
  children.unshift(child("new"));
  assert.match(widget.render(200).find((line) => line.startsWith("›"))!, /Worker two/);
});

test("real TUI overlay navigation preserves a mid-line draft and paste, and does not steal a dialog's focus", async (t) => {
  let input: (data: string) => void = () => {};
  const terminal: Terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start: (handler) => { input = handler; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiMainScreen(terminal);
  t.after(() => tui.stop());
  const identity = (text: string) => text;
  const editor = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity,
    description: identity, scrollInfo: identity, noMatch: identity } });
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();
  editor.setText("alpha beta");
  for (let i = 0; i < 4; i++) input("\x1b[D");
  const cursor = editor.getCursor();
  const widget = new StatusWidget(() => [child("one"), child("two")]);
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (_key: string, factory: (tui: TUI, theme: Theme) => Component) => { tui.addChild(factory(tui, {} as Theme)); },
      custom: (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => Component) => new Promise<void>((resolve) => {
        const component = factory(tui, {} as Theme, {} as KeybindingsManager, () => { handle.hide(); resolve(); });
        const handle = tui.showOverlay(component);
      }),
      notify() {},
    },
  } as unknown as ExtensionContext;
  widget.install(ctx);
  let navigation = widget.navigate(ctx);
  input("\x1b[B");
  assert.equal(widget.selectedId, "two");
  input("\x1b");
  await navigation;
  assert.deepEqual(editor.getCursor(), cursor);
  input("X");
  assert.equal(editor.getText(), "alpha Xbeta");

  const paste = "\n".repeat(40) + "pasted text";
  input(`\x1b[200~${paste}\x1b[201~`);
  const pastedText = editor.getExpandedText();
  const pastedCursor = editor.getCursor();
  navigation = widget.navigate(ctx);
  const dialog = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity,
    description: identity, scrollInfo: identity, noMatch: identity } });
  tui.addChild(dialog);
  tui.setFocus(dialog);
  widget.close();
  await navigation;
  input("dialog-value");
  assert.equal(dialog.getText(), "dialog-value");
  assert.equal(editor.getExpandedText(), pastedText);
  assert.deepEqual(editor.getCursor(), pastedCursor);
  tui.setFocus(editor);
  navigation = widget.navigate(ctx);
  widget.dispose();
  widget.dispose();
  await navigation;
  assert.equal(tui.hasOverlay(), false);
});

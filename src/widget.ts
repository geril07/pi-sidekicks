import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExtensionEditorComponent } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type EditorComponent, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ChildSnapshot } from "./manager.ts";
import { elapsedOf, isActive, modelLabel, plain, plainStyle, stateGlyph, stateWord, summary, type Style } from "./present.ts";

const WIDGET_KEY = "sidekicks";
const VISIBLE_ROWS = 10;
const REFRESH_MS = 1000;

const rightAlign = (left: string, right: string, width: number) => {
  const room = Math.max(0, width - visibleWidth(right) - 1);
  const clipped = truncateToWidth(left, room);
  return truncateToWidth(`${clipped}${" ".repeat(Math.max(1, width - visibleWidth(clipped) - visibleWidth(right)))}${right}`, width);
};

/**
 * Compact status below the editor. Down on an empty editor moves selection into the rows,
 * the same entry gesture as the pi-subagents fleet status; every other key reaches the editor.
 */
export class StatusWidget implements Component {
  expanded = false;
  focused = false;
  selectedId?: string;
  detailId?: string;
  private snapshot: () => ChildSnapshot[];
  private style: Style = plainStyle;
  private ui?: ExtensionContext["ui"];
  private tui?: TUI;
  private rowIds: (string | undefined)[] = [];
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private suspended = false;
  private disposed = false;

  constructor(snapshot: () => ChildSnapshot[]) { this.snapshot = snapshot; }

  install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    this.ui = ctx.ui;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.tui = tui;
      this.style = theme;
      return this;
    }, { placement: "belowEditor" });
    this.unsubscribe = ctx.ui.onTerminalInput((data) => this.handleKey(data));
    this.timer = setInterval(() => { if (this.expanded && this.snapshot().some((child) => !child.external && isActive(child.run.state))) this.refresh(); }, REFRESH_MS);
    this.timer.unref();
  }

  refresh(): void { if (!this.disposed) this.tui?.requestRender(); }
  invalidate(): void {}

  toggle(): void {
    this.expanded = !this.expanded;
    if (!this.expanded) this.blur();
    this.refresh();
  }

  /** Enter row selection without a keystroke, for the /sidekicks command. */
  focus(): void {
    if (this.disposed || !this.snapshot().length) return;
    this.expanded = true;
    this.focused = true;
    this.selected();
    this.refresh();
  }

  /** Give input back to the editor; dialogs call this so they own the keyboard. */
  blur(): void {
    this.focused = false;
    this.detailId = undefined;
    this.refresh();
  }

  /** Leave row selection by the user's choice: the list returns to its summary line, as in the fleet status. */
  private leave(): void {
    this.expanded = false;
    this.blur();
  }

  /** Hold off selection while a relayed child dialog is open. */
  suspend(value: boolean): void {
    this.suspended = value;
    if (value) this.blur();
  }

  /** Live work first, in launch order so rows stay put; finished conversations after, newest first. */
  private ordered(): ChildSnapshot[] {
    const finishedAt = (child: ChildSnapshot) => child.run.endedAt ?? child.run.startedAt ?? 0;
    const live = (child: ChildSnapshot) => !child.external && isActive(child.run.state);
    return [...this.snapshot()].sort((a, b) => Number(live(b)) - Number(live(a))
      || (live(a) ? 0 : finishedAt(b) - finishedAt(a)));
  }

  private selected(children = this.ordered()): number {
    const index = children.findIndex((child) => child.id === this.selectedId);
    if (index >= 0) return index;
    this.selectedId = children[0]?.id;
    return 0;
  }

  render(width: number): string[] {
    const children = this.ordered();
    this.rowIds = [];
    if (!children.length) return [];
    const { style } = this;
    const hint = this.focused ? style.fg("dim", " · ↑↓ select · enter details · esc back") : "";
    const header = truncateToWidth(` ${style.fg("muted", this.expanded ? "▾" : "▸")} ${style.fg("muted", "sidekicks")} ${summary(style, children)}${hint}`, width);
    const lines = [header];
    this.rowIds.push(undefined);
    if (!this.expanded) return lines;
    const selected = this.selected(children);
    const first = Math.min(Math.max(0, selected - VISIBLE_ROWS + 1), Math.max(0, children.length - VISIBLE_ROWS));
    if (first > 0) { lines.push(truncateToWidth(style.fg("dim", `   ↑ ${first} more`), width)); this.rowIds.push(undefined); }
    for (const child of children.slice(first, first + VISIBLE_ROWS)) {
      lines.push(this.row(child, child.id === this.selectedId && this.focused, width));
      this.rowIds.push(child.id);
      if (child.id === this.detailId) { lines.push(this.detail(child, width)); this.rowIds.push(child.id); }
    }
    const hidden = children.length - first - VISIBLE_ROWS;
    if (hidden > 0) { lines.push(truncateToWidth(style.fg("dim", `   ↓ ${hidden} more`), width)); this.rowIds.push(undefined); }
    return lines;
  }

  private row(child: ChildSnapshot, selected: boolean, width: number): string {
    const { style } = this;
    const state = child.external ? style.fg("muted", `another window (saved ${child.run.state})`)
      : child.connected || !isActive(child.run.state) ? stateWord(style, child.run.state) : style.fg("warning", `detached/${child.run.state}`);
    const agent = child.agent === child.name ? "" : `${child.agent} `;
    const reason = ["failed", "interrupted"].includes(child.run.state) ? child.run.result?.split("\n").find((line) => line.trim()) ?? "" : "";
    const left = `${selected ? style.fg("accent", ">") : " "} ${child.external ? style.fg("muted", "↗") : stateGlyph(style, child.run.state)} ${style.bold(plain(child.name))} ${style.fg("dim", `${plain(agent)}${plain(modelLabel(child))}`)} ${state}${reason ? style.fg("muted", ` · ${plain(reason)}`) : ""}`;
    const elapsed = child.external ? undefined : elapsedOf(child.run);
    const compact = (value: number) => value < 1000 ? String(Math.round(value)) : `${Number((value / 1000).toFixed(1))}k`;
    const usage = child.contextUsage;
    const context = `${usage?.tokens == null ? "—" : compact(usage.tokens)}/${usage ? compact(usage.contextWindow) : "—"}`;
    const metrics = `${child.run.turns ?? "—"} turns · ${child.run.tools ?? "—"} tools · ctx ${context}`;
    const measurement = style.fg("dim", `${metrics}${elapsed ? `    ${elapsed}` : ""}`);
    const notification = !child.external && child.notificationExternal ? " · notification in another window"
      : !child.external && child.run.groupId && child.run.state === "completed" && !child.run.delivered ? " · result held" : "";
    const suffix = visibleWidth(left) + notification.length + visibleWidth(measurement) + 2 <= width ? notification : "";
    return rightAlign(` ${left}${style.fg("muted", suffix)}`, measurement, width);
  }

  /** Where the child's transcript and result files live, for finding them from a shell. */
  private detail(child: ChildSnapshot, width: number): string {
    return truncateToWidth(this.style.fg("dim", `     ${plain(dirname(child.sessionPath))}`), width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    if (event.y === 0) { this.toggle(); return { handled: true }; }
    const id = this.rowIds[event.y];
    if (!id) return undefined;
    this.selectedId = id;
    this.detailId = this.detailId === id ? undefined : id;
    this.refresh();
    return { handled: true };
  }

  private editorFocused(): boolean {
    // The TUI class exposes the focused component; its public interface does not.
    const focused = (this.tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.() as Partial<EditorComponent> | null | undefined;
    if (!focused || typeof focused.getText !== "function" || typeof focused.setText !== "function" || typeof focused.handleInput !== "function") return false;
    // A dialog's editor is also editor-shaped; the main editor is the one whose text Pi reports.
    return focused.getText() === this.ui?.getEditorText();
  }

  handleKey(data: string): { consume?: boolean } | undefined {
    if (this.disposed || isKeyRelease(data)) return undefined;
    const children = this.ordered();
    if (!children.length || this.suspended || !this.editorFocused()) {
      if (this.focused) this.blur();
      return undefined;
    }
    if (!this.focused) {
      if (!matchesKey(data, "down") || this.ui?.getEditorText() !== "") return undefined;
      this.focus();
      return { consume: true };
    }
    let index = this.selected(children);
    if (matchesKey(data, "down") || matchesKey(data, "j")) index = Math.min(children.length - 1, index + 1);
    else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (index === 0) { this.leave(); return { consume: true }; }
      index -= 1;
    } else if (matchesKey(data, "enter")) {
      this.detailId = this.detailId === children[index].id ? undefined : children[index].id;
    } else if (matchesKey(data, "escape")) {
      this.leave();
      return { consume: true };
    } else {
      this.leave();
      return undefined;
    }
    this.selectedId = children[index].id;
    if (this.detailId && this.detailId !== this.selectedId) this.detailId = undefined;
    this.refresh();
    return { consume: true };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.timer);
    this.tui = undefined;
  }
}

export async function cancellableEditor(ctx: ExtensionContext, title: string, prefill: string | undefined, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  if (ctx.mode !== "tui") throw new Error("Cancellable multiline editor bridging requires a TUI parent");
  let cancel: (() => void) | undefined;
  try {
    return await ctx.ui.custom<string | undefined>((tui, _theme, keys, done) => {
      cancel = () => done(undefined);
      signal.addEventListener("abort", cancel, { once: true });
      return new ExtensionEditorComponent(tui, keys, title, prefill, done, cancel);
    }, { overlay: true });
  } finally { if (cancel) signal.removeEventListener("abort", cancel); }
}

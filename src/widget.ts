import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExtensionEditorComponent } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ChildSnapshot } from "./manager.ts";

const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const fit = (value: string, width: number) => truncateToWidth(plain(value), Math.max(1, width));

export class StatusWidget implements Component {
  expanded = false;
  selectedId?: string;
  private snapshot: () => ChildSnapshot[];
  private repaint: () => void = () => {};
  private closeNavigation?: () => void;
  private disposed = false;

  constructor(snapshot: () => ChildSnapshot[]) { this.snapshot = snapshot; }

  install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("sidekicks", (tui) => {
      this.repaint = () => tui.requestRender();
      return this;
    }, { placement: "aboveEditor" });
  }

  refresh(): void { if (!this.disposed) this.repaint(); }
  toggle(): void { this.expanded = !this.expanded; this.refresh(); }
  invalidate(): void {}

  render(width: number): string[] {
    const children = this.snapshot();
    const running = children.filter((child) => ["starting", "running"].includes(child.run.state)).length;
    const waiting = children.filter((child) => child.run.state === "waiting").length;
    const lines = [fit(`Sidekicks ${this.expanded ? "▾" : "▸"} ${running} working · ${waiting} waiting · ${children.length} total  [ctrl+alt+s / ctrl+alt+n]`, width)];
    if (!this.expanded) return lines;
    if (!children.length) return [...lines, fit("  No children launched.", width)];
    let selected = children.findIndex((child) => child.id === this.selectedId);
    if (selected < 0) { selected = 0; this.selectedId = children[0].id; }
    const first = Math.max(0, selected - 7);
    for (const child of children.slice(first, first + 8)) {
      const state = child.connected ? child.run.state : `detached/${child.run.state}`;
      lines.push(fit(`${child.id === this.selectedId ? "›" : " "} ${child.name} (${child.role}) · ${child.model}/${child.thinking} · ${state} · ${child.activity}`, width));
    }
    if (children.length > 8) lines.push(fit(`  ${first + 1}–${Math.min(first + 8, children.length)} of ${children.length}`, width));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "click" && event.button === "left" && event.y === 0) {
      this.toggle();
      return { handled: true };
    }
    return undefined;
  }

  async navigate(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || this.disposed || this.closeNavigation) return;
    this.expanded = true;
    this.refresh();
    await ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
      let closed = false;
      this.closeNavigation = () => {
        if (closed) return;
        closed = true;
        this.closeNavigation = undefined;
        done();
      };
      return {
        render: (width) => [fit("Sidekicks: ↑↓ select · ←→ collapse/expand · Enter details · Esc editor", width)],
        invalidate() {},
        handleInput: (data) => {
          if (matchesKey(data, "escape")) { this.close(); return; }
          const children = this.snapshot();
          let selected = Math.max(0, children.findIndex((child) => child.id === this.selectedId));
          if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
          if (matchesKey(data, "down")) selected = Math.min(children.length - 1, selected + 1);
          this.selectedId = children[selected]?.id;
          if (matchesKey(data, "left")) this.expanded = false;
          if (matchesKey(data, "right")) this.expanded = true;
          if (matchesKey(data, "return") && children[selected]) {
            const child = children[selected];
            this.close();
            ctx.ui.notify(plain(`${child.name} · ${child.run.state}\nChild: ${child.id}\nRun: ${child.run.id}\n${child.run.question ? `Question ${child.run.question.id}: ${child.run.question.text}` : child.run.result ?? child.activity}`).slice(0, 8000), "info");
          }
          this.refresh();
        },
      };
    }, { overlay: true });
  }

  close(): void { this.closeNavigation?.(); }
  dispose(): void { this.close(); this.disposed = true; this.repaint = () => {}; }
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

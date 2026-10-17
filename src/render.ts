import { getMarkdownTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, MouseRegion, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ChildSnapshot, RunState } from "./manager.ts";
import { elapsedOf, modelLabel, plain, stateGlyph, stateWord, summary } from "./present.ts";

/** Saved with each delivered message so the transcript view never has to parse model-facing text. */
export interface DeliveryDetails { kind: "question" | "result"; child: string; state: RunState; questionId?: string; blocking?: boolean; elapsed?: string; body: string }
/** Saved with each tool result for the same reason. */
export interface ToolDetails { action: string; child?: ChildSnapshot; children?: ChildSnapshot[]; agents?: string[] }

const COLLAPSED_LINES = 3;
const oneLine = (value: string, length: number) => {
  const line = plain(value).replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** A click toggles one block until Pi's expand key changes every block, as in Pi's own [skill] blocks. */
const clicked = new WeakMap<object, { byPi: boolean; expanded: boolean }>();

class DeliveryBlock extends Box {
  private readonly message: object;
  private readonly details: DeliveryDetails;
  private readonly byPi: boolean;
  private readonly theme: Theme;

  constructor(message: object, details: DeliveryDetails, byPi: boolean, theme: Theme) {
    super(1, 1, (text) => theme.bg("customMessageBg", text));
    this.message = message;
    this.details = details;
    this.byPi = byPi;
    this.theme = theme;
    if (clicked.get(message)?.byPi !== byPi) clicked.delete(message);
    this.rebuild();
  }

  private expanded() { return clicked.get(this.message)?.expanded ?? this.byPi; }

  private rebuild(): void {
    const { theme, details } = this;
    const expanded = this.expanded();
    const asks = details.kind === "question";
    const status = asks ? theme.fg("warning", details.blocking ? "asks · paused" : "asks") : stateWord(theme, details.state);
    const title = `${theme.fg("customMessageLabel", theme.bold("[sidekick]"))} ${theme.fg("customMessageText", plain(details.child))} ${status}`
      + (details.elapsed && !asks ? theme.fg("dim", ` · ${details.elapsed}`) : "");
    const lines = details.body.split("\n").map(plain);
    const hidden = Math.max(0, lines.length - COLLAPSED_LINES);
    const content = new Container();
    content.addChild({ render: (width) => [truncateToWidth(title, width, "…")], invalidate() {} });
    if (details.body.trim()) {
      content.addChild(new Spacer(1));
      if (expanded) content.addChild(new Markdown(details.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " "), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
      else {
        const shown = lines.slice(0, COLLAPSED_LINES).join("\n");
        content.addChild(new Text(theme.fg(asks ? "customMessageText" : "muted", shown), 0, 0));
        if (hidden > 0) content.addChild(new Text(theme.fg("dim", `… ${hidden} more lines (${keyText("app.tools.expand") || "click"} to expand)`), 0, 0));
      }
    }
    this.clear();
    this.addChild(new MouseRegion(content, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      clicked.set(this.message, { byPi: this.byPi, expanded: !this.expanded() });
      this.rebuild();
      return { handled: true };
    }));
  }
}

export function renderDelivery(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme): Component | undefined {
  const details = message.details as DeliveryDetails | undefined;
  if (!details || typeof details.child !== "string" || typeof details.body !== "string") return undefined;
  return new DeliveryBlock(message, details, options.expanded, theme);
}

export function renderCall(args: Record<string, unknown>, theme: Theme): Component {
  const text = (key: string) => typeof args[key] === "string" ? args[key] as string : "";
  const target = text("agent") || text("child");
  const body = text("task") || text("message") || text("answer");
  const name = text("agent") && text("name") ? theme.fg("dim", ` as ${plain(text("name"))}`) : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", text("action") || "?")}${target ? ` ${theme.fg("customMessageText", plain(target))}` : ""}${name}${body ? theme.fg("dim", `  ${oneLine(body, 100)}`) : ""}`, 0, 0);
}

export function renderResult(result: { content: { type: string; text?: string }[]; details?: ToolDetails }, options: { expanded: boolean }, theme: Theme, isError: boolean): Component {
  const message = result.content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("\n");
  const details = result.details;
  if (isError || !details) return new Text(theme.fg(isError ? "error" : "muted", plain(message)), 0, 0);
  const line = (child: ChildSnapshot) => `${stateGlyph(theme, child.run.state)} ${theme.bold(plain(child.name))} ${theme.fg("dim", `${child.agent === child.name ? "" : `${plain(child.agent)} `}${plain(modelLabel(child))}`)} ${stateWord(theme, child.run.state)}${elapsedOf(child.run) ? theme.fg("dim", ` · ${elapsedOf(child.run)}`) : ""}`;
  if (details.child) return new Text(line(details.child), 0, 0);
  const children = details.children ?? [];
  if (!children.length) return new Text(theme.fg("muted", "No children yet."), 0, 0);
  return new Text(options.expanded ? children.map(line).join("\n") : summary(theme, children), 0, 0);
}

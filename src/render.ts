import { getMarkdownTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, MouseRegion, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ChildSnapshot, RunState } from "./manager.ts";
import { groupHeadline, elapsedOf, isActive, modelLabel, plain, stateGlyph, stateWord, summary, type GroupDisposition } from "./present.ts";

/** Saved with each delivered message so the transcript view never has to parse model-facing text. */
export interface DeliveryDetails { kind: "question" | "result"; child: string; state: RunState; questionId?: string; blocking?: boolean; elapsed?: string; body: string }
export interface GroupDetails { kind: "group"; source?: "notification"; restored?: boolean; members: { child: string; state: RunState; body: string; disposition?: GroupDisposition }[] }
/** Saved with each tool result for the same reason. */
export interface ToolDetails { action: string; notice?: string; child?: ChildSnapshot; children?: ChildSnapshot[]; agents?: string[]; outcomes?: { child: ChildSnapshot; error?: string }[] }

const COLLAPSED_LINES = 3;
/** Markdown keeps newlines and tabs; every other terminal control character becomes a space. */
const MARKDOWN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const expandKey = () => keyText("app.tools.expand") || "click";
const oneLine = (value: string, length: number) => {
  const line = plain(value).replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};

/** A click toggles one block until Pi's expand key changes every block, as in Pi's own [skill] blocks. */
const clicked = new WeakMap<object, { byPi: boolean; expanded: boolean }>();

class DeliveryBlock extends Box {
  private readonly message: object;
  private readonly details: DeliveryDetails | GroupDetails;
  private readonly byPi: boolean;
  private readonly theme: Theme;

  constructor(message: object, details: DeliveryDetails | GroupDetails, byPi: boolean, theme: Theme) {
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
    if (details.kind === "group") {
      const content = new Container();
      if (details.restored) content.addChild(new Text("Combined results after session restore.", 0, 0));
      content.addChild(new Text(`${theme.fg("customMessageLabel", theme.bold("[sidekick]"))} ${groupHeadline(details.members, details.source === "notification")}`, 0, 0));
      for (const member of details.members) {
        content.addChild(new Spacer(1));
        content.addChild(new Text(`${theme.bold(plain(member.child))} ${stateWord(theme, member.state)}`, 0, 0));
        if (expanded) content.addChild(new Markdown(member.body.replace(MARKDOWN_CONTROL, " "), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
        else content.addChild(new Text(theme.fg("muted", oneLine(member.body, 160)), 0, 0));
      }
      this.setContent(content);
      return;
    }
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
      if (expanded) content.addChild(new Markdown(details.body.replace(MARKDOWN_CONTROL, " "), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
      else {
        const shown = lines.slice(0, COLLAPSED_LINES).join("\n");
        content.addChild(new Text(theme.fg(asks ? "customMessageText" : "muted", shown), 0, 0));
        if (hidden > 0) content.addChild(new Text(theme.fg("dim", `… ${hidden} more lines (${expandKey()} to expand)`), 0, 0));
      }
    }
    this.setContent(content);
  }

  private setContent(content: Container): void {
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

export function renderGroup(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme): Component | undefined {
  const details = message.details as GroupDetails | undefined;
  if (details?.kind !== "group" || !Array.isArray(details.members)) return undefined;
  return new DeliveryBlock(message, details, options.expanded, theme);
}

export function renderCall(args: Record<string, unknown>, theme: Theme): Component {
  const text = (key: string) => typeof args[key] === "string" ? args[key] as string : "";
  if (args.tool === "subagent_group_results") {
    return new Text(`${theme.fg("toolTitle", theme.bold("subagent_group_results"))} ${Array.isArray(args.children) ? args.children.map((child) => plain(String(child))).join(", ") : ""}`, 0, 0);
  }
  // Retained only for saved batch calls; new launch schemas do not accept tasks.
  const target = Array.isArray(args.tasks) ? `batch of ${args.tasks.length}` : text("agent") || text("child");
  const name = text("agent") && text("name") ? theme.fg("dim", ` as ${plain(text("name"))}`) : "";
  return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", text("action") || "?")}${target ? ` ${theme.fg("customMessageText", plain(target))}` : ""}${name}`, 0, 0);
}

/** The prompt the parent wrote, which the call line no longer carries. Collapsed rows are wrapped to the width before they are counted. */
function promptBlock(prompt: string, expanded: boolean, theme: Theme): Component {
  if (expanded) return new Markdown(prompt.replace(MARKDOWN_CONTROL, " "), 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) });
  const rows = new Text(theme.fg("muted", prompt.trimEnd().split("\n").map(plain).join("\n")), 0, 0);
  return {
    render(width) {
      const wrapped = rows.render(width);
      if (wrapped.length <= COLLAPSED_LINES) return wrapped;
      return [...wrapped.slice(0, COLLAPSED_LINES), ...new Text(theme.fg("dim", `… ${wrapped.length - COLLAPSED_LINES} more lines (${expandKey()} to expand)`), 0, 0).render(width)];
    },
    invalidate: () => rows.invalidate(),
  };
}

export function renderResult(result: { content: { type: string; text?: string }[]; details?: ToolDetails }, options: { expanded: boolean }, theme: Theme, context: { args: Record<string, unknown>; isError: boolean }): Component {
  const message = result.content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []).join("\n");
  const { args, isError } = context;
  const details = result.details;
  const prompt = [args.task, args.message, args.answer].find((value): value is string => typeof value === "string" && value.trim() !== "");
  const content = new Container();
  // The child's state at return time goes stale, so only a final state is drawn.
  const identity = (child: ChildSnapshot) => `${theme.bold(plain(child.name))} ${theme.fg("dim", `${child.agent === child.name ? "" : `${plain(child.agent)} `}${plain(modelLabel(child))}`)}`;
  const row = (child: ChildSnapshot) => `${identity(child)}${isActive(child.run.state) ? "" : ` ${stateWord(theme, child.run.state)}`}`;
  if (isError || !details) {
    content.addChild(new Text(theme.fg(isError ? "error" : "muted", plain(message)), 0, 0));
    if (isError && prompt) content.addChild(promptBlock(prompt, options.expanded, theme));
    return content;
  }
  const line = (child: ChildSnapshot) => `${stateGlyph(theme, child.run.state)} ${identity(child)} ${stateWord(theme, child.run.state)}${elapsedOf(child.run) ? theme.fg("dim", ` · ${elapsedOf(child.run)}`) : ""}`;
  if (details.child) {
    content.addChild(new Text(row(details.child), 0, 0));
    if (details.notice) content.addChild(new Text(plain(details.notice), 0, 0));
    if (prompt) content.addChild(promptBlock(prompt, options.expanded, theme));
    return content;
  }
  if (details.outcomes) {
    const tasks = Array.isArray(args.tasks) ? args.tasks as { task?: unknown }[] : [];
    const shared = typeof args.shared === "string" && args.shared.trim() ? `${args.shared}\n\n` : "";
    const prompts = details.outcomes.map((_, i) => typeof tasks[i]?.task === "string" ? shared + tasks[i].task : undefined);
    details.outcomes.forEach(({ child, error }, i) => {
      if (options.expanded && i > 0) content.addChild(new Spacer(1));
      content.addChild(new Text(row(child), 0, 0));
      const reason = error?.split("\n").map((part) => part.trim()).find(Boolean);
      if (reason) content.addChild(new Text(theme.fg("error", `startup failed: ${plain(reason)}`), 0, 0));
      if (options.expanded && prompts[i]) content.addChild(promptBlock(prompts[i]!, true, theme));
    });
    if (!options.expanded && prompts.some(Boolean)) content.addChild(new Text(theme.fg("dim", `${expandKey()} to expand`), 0, 0));
    return content;
  }
  const children = details.children ?? [];
  if (!children.length) content.addChild(new Text(theme.fg("muted", "No children yet."), 0, 0));
  else content.addChild(new Text(options.expanded ? children.map(line).join("\n") : summary(theme, children), 0, 0));
  return content;
}

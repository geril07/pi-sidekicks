import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type RpcExtensionUIRequest, type RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { Manager, type ChildRecord, type ChildSnapshot } from "./manager.ts";
import { discoverAgents, thinkingLevels } from "./agents.ts";
import { StatusWidget, cancellableEditor } from "./widget.ts";
import { deliveryText, describeChild, elapsedOf, statusText } from "./present.ts";
import { renderCall, renderDelivery, renderResult, type DeliveryDetails, type ToolDetails } from "./render.ts";
import type { Invocation } from "./rpc.ts";

const STATE_ENTRY = "sidekicks:state";
const DESCRIPTION = [
  "Delegate work to asynchronous child agents. Each child is a full Pi session with its own conversation; launch returns as soon as the child is running.",
  "- launch: agent + task. Write the task so it stands alone (goal, relevant paths, constraints, what to return). Optional name (unique handle), model, thinking; these apply at launch only.",
  "- send: child + message. Steers a running child; starts a new run in a finished child's existing conversation.",
  "- answer: child + questionId + answer. Replies to a question the child asked.",
  "- stop: child. Ends the work and keeps the conversation.",
  "- status: children and available agents.",
  "Address a child by its name. Results and questions arrive as messages; do not poll or wait in a loop. Up to 64 children may be active.",
].join("\n");

function invocation(): Invocation {
  const entry = process.argv[1];
  if (entry && existsSync(entry) && /^(?:cli|pi)\.[cm]?[jt]s$/.test(basename(entry))) return { command: process.execPath, args: [entry] };
  if (!/^(?:node|bun)(?:\.exe)?$/.test(basename(process.execPath))) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

function restored(ctx: ExtensionContext): ChildRecord[] {
  const records = new Map<string, ChildRecord>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const record = entry.data as ChildRecord | undefined;
    if (!record || typeof record.id !== "string" || typeof record.ownerSessionId !== "string"
      || typeof record.instructions !== "string" || typeof record.sessionPath !== "string"
      || typeof record.name !== "string" || typeof record.agent !== "string" || typeof record.cwd !== "string"
      || typeof record.model !== "string" || !thinkingLevels.includes(record.thinking)
      || !record.run || typeof record.run.id !== "string" || typeof record.run.state !== "string") continue;
    records.set(record.id, record);
  }
  return [...records.values()];
}

export default function sidekicks(pi: ExtensionAPI): void {
  if (process.env.PI_SIDEKICKS_CHILD) return;
  let current: { manager: Manager; widget: StatusWidget; ctx: ExtensionContext } | undefined;
  const getAgents = (ctx: ExtensionContext) => {
    const config = (pi.getSettings() as { sidekicks?: unknown }).sidekicks;
    if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) throw new Error("sidekicks settings must be an object");
    return discoverAgents(ctx.cwd, ctx.isProjectTrusted(), { agentsDir: (config as { agentsDir?: unknown } | undefined)?.agentsDir });
  };

  const start = (ctx: ExtensionContext) => {
    const ownerSessionId = ctx.sessionManager.getSessionId();
    const directory = join(getAgentDir(), "sidekicks", createHash("sha256").update(ownerSessionId).digest("hex").slice(0, 24));
    let dialogTail: Promise<unknown> = Promise.resolve();
    const runtime = { manager: undefined as unknown as Manager, widget: undefined as unknown as StatusWidget, ctx };
    const dialog = (child: ChildSnapshot, request: RpcExtensionUIRequest, signal: AbortSignal): Promise<RpcExtensionUIResponse | undefined> => {
      if (request.method === "notify") {
        if (current === runtime && !signal.aborted) ctx.ui.notify(`${child.name}: ${request.message}`, request.notifyType);
        return Promise.resolve(undefined);
      }
      if (!["select", "confirm", "input", "editor"].includes(request.method)) return Promise.resolve(undefined);
      if ("timeout" in request && request.timeout !== undefined) {
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.timeout))]);
      }
      const result = dialogTail.then(async (): Promise<RpcExtensionUIResponse> => {
        const cancelled: RpcExtensionUIResponse = { type: "extension_ui_response", id: request.id, cancelled: true };
        if (current !== runtime || signal.aborted || !ctx.hasUI) return cancelled;
        runtime.widget.suspend(true);
        const title = `${child.name}: ${"title" in request ? request.title : "Interaction"}`;
        try {
          let value: string | undefined;
          const timeout = "timeout" in request ? request.timeout : undefined;
          const options = { signal, timeout };
          if (request.method === "confirm") return { type: "extension_ui_response", id: request.id,
            confirmed: await ctx.ui.confirm(title, request.message, options) };
          if (request.method === "select") value = await ctx.ui.select(title, request.options, options);
          else if (request.method === "input") value = await ctx.ui.input(title, request.placeholder, options);
          else if (request.method === "editor") value = await cancellableEditor(ctx, title, request.prefill, signal);
          return value === undefined ? cancelled : { type: "extension_ui_response", id: request.id, value };
        } catch (error) {
          if (current === runtime && !signal.aborted) ctx.ui.notify(`Child interaction cancelled: ${String(error)}`, "warning");
          return cancelled;
        } finally { runtime.widget.suspend(false); }
      });
      dialogTail = result.catch(() => {});
      return result;
    };
    runtime.manager = new Manager({ ownerSessionId, directory, cwd: ctx.cwd, trusted: ctx.isProjectTrusted(),
      invocation: invocation(), restored: restored(ctx), dialog,
      persist: (record) => {
        if (ctx.sessionManager.getSessionId() === ownerSessionId) pi.appendEntry(STATE_ENTRY, record);
      },
      changed: () => runtime.widget?.refresh(),
      deliver: (child, kind, question) => {
        if (current !== runtime) return;
        const blocking = kind === "question" && child.run.question?.id === question?.id;
        const details: DeliveryDetails = { kind, child: child.name, state: child.run.state, questionId: question?.id, blocking,
          elapsed: elapsedOf(child.run), body: kind === "question" ? question!.text : child.run.result ?? "" };
        pi.sendMessage({ customType: `sidekicks:${kind}`, content: deliveryText(child, kind, question, blocking), display: true, details },
          { triggerTurn: true, deliverAs: "followUp" });
      },
    });
    runtime.widget = new StatusWidget(() => runtime.manager.snapshot());
    current = runtime;
    runtime.widget.install(ctx);
  };

  pi.on("session_start", (_event, ctx) => { start(ctx); });
  pi.on("session_shutdown", async () => {
    const runtime = current;
    current = undefined;
    runtime?.widget.dispose();
    await runtime?.manager.shutdown();
  });
  pi.on("session_tree", async (_event, ctx) => {
    const runtime = current;
    current = undefined;
    runtime?.widget.dispose();
    await runtime?.manager.shutdown(false);
    start(ctx);
  });

  const text = (description: string, extra: { maxLength?: number } = {}) => Type.Optional(Type.String({ description, ...extra }));
  const agentList = (ctx: ExtensionContext) => getAgents(ctx).map((agent) => {
    const defaults = [agent.model, agent.thinking].filter(Boolean).join(":");
    return `- ${agent.name}${defaults ? ` (default ${defaults})` : ""}: ${agent.description.replace(/\s+/g, " ").trim()}`;
  }).join("\n");

  pi.registerTool({
    name: "subagent", label: "Subagent", exposure: "model-only", description: DESCRIPTION,
    promptSnippet: "Delegate to asynchronous child agents (launch, send, answer, stop, status)",
    parameters: Type.Object({
      action: Type.Union(["launch", "send", "answer", "stop", "status"].map((value) => Type.Literal(value))),
      agent: text("launch: agent definition to use, from the Agents list"),
      task: text("launch: the complete, self-contained assignment"),
      name: text("launch: unique handle for this child; defaults to the agent name", { maxLength: 100 }),
      model: text("launch: provider/model id; defaults to the agent's model, then the parent's"),
      thinking: Type.Optional(Type.Union(thinkingLevels.map((level) => Type.Literal(level)), { description: "launch: thinking level" })),
      child: text("send/answer/stop: the child's name"),
      message: text("send: guidance for a running child, or the next assignment for a finished one"),
      questionId: text("answer: id from the child's question"),
      answer: text("answer: your reply"),
    }),
    prepareLoadout: () => {
      if (!current) return;
      let agents: string;
      try { agents = agentList(current.ctx); }
      catch { agents = "Agent configuration error; call status for details."; }
      return { descriptions: { subagent: `${DESCRIPTION}\n\nAgents:\n${agents || "none; add Markdown definitions to the configured sidekicks.agentsDir or default sidekicks/ folder"}` } };
    },
    renderCall: (args, theme) => renderCall(args, theme),
    renderResult: (result, options, theme, context) => renderResult(result as Parameters<typeof renderResult>[0], options, theme, context.isError),
    async execute(_id, args, signal, _update, ctx) {
      const runtime = current;
      if (!runtime || runtime.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Sidekicks session is not ready");
      const fields: Record<string, string[]> = { launch: ["agent", "task", "name", "model", "thinking"],
        send: ["child", "message"], answer: ["child", "questionId", "answer"], stop: ["child"], status: [] };
      const unexpected = Object.entries(args).filter(([key, value]) => key !== "action" && value !== undefined && !fields[args.action]?.includes(key));
      if (unexpected.length) throw new Error(`${args.action} does not take: ${unexpected.map(([key]) => key).join(", ")}. It takes: ${fields[args.action].join(", ") || "nothing"}.`);
      const requireText = (name: "agent" | "task" | "child" | "message" | "questionId" | "answer") => {
        const value = args[name];
        if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required for ${args.action}`);
        return value;
      };
      const done = (prefix: string, child: ChildSnapshot): { content: { type: "text"; text: string }[]; details: ToolDetails } =>
        ({ content: [{ type: "text", text: `${prefix} ${describeChild(child)}` }], details: { action: args.action, child } });
      switch (args.action) {
        case "launch": {
          const agents = getAgents(ctx);
          const agent = agents.find((agent) => agent.name === requireText("agent"));
          if (!agent) throw new Error(`Unknown agent. Available: ${agents.map((agent) => agent.name).join(", ") || "none"}`);
          const model = args.model ?? agent.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
          if (!model) throw new Error("No launch, agent, or parent model is available");
          const child = await runtime.manager.launch({ agent: agent.name, instructions: agent.instructions, name: args.name,
            task: requireText("task"), model, thinking: args.thinking ?? agent.thinking ?? pi.getThinkingLevel() }, signal);
          return done("Launched. Its result or questions arrive as messages; do not poll.\n", child);
        }
        case "send": return done("Sent.", await runtime.manager.send(requireText("child"), requireText("message"), signal));
        case "answer": return done("Answered.", await runtime.manager.answer(requireText("child"), requireText("questionId"), requireText("answer"), signal));
        case "stop": return done("Stopped; conversation kept.", await runtime.manager.stop(requireText("child")));
        case "status": {
          const children = runtime.manager.snapshot();
          return { content: [{ type: "text", text: statusText(children, getAgents(ctx)) }],
            details: { action: "status", children } satisfies ToolDetails };
        }
        default: throw new Error("Unknown subagent action");
      }
    },
  });

  for (const kind of ["question", "result"]) pi.registerMessageRenderer(`sidekicks:${kind}`, (message, options, theme) => renderDelivery(message, options, theme));
  pi.registerCommand("sidekicks", { description: "Inspect sidekicks without a model turn", handler: async (_args, ctx) => {
    if (!current) return;
    if (ctx.mode === "tui") {
      if (current.manager.snapshot().length) current.widget.focus();
      else ctx.ui.notify("No sidekicks yet.", "info");
    } else ctx.ui.notify(statusText(current.manager.snapshot(), getAgents(ctx)), "info");
  } });
}

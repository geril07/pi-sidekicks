import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type RpcExtensionUIRequest, type RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { Manager, type ChildRecord, type ChildSnapshot } from "./manager.ts";
import { discoverRoles, thinkingLevels } from "./roles.ts";
import { StatusWidget, cancellableEditor } from "./widget.ts";
import type { Invocation } from "./rpc.ts";

const STATE_ENTRY = "sidekicks:state";
const DESCRIPTION = "Launch up to 64 asynchronous role-based Pi assignments, send guidance/follow-up, answer a specific child question, stop work, or inspect status. Launch waits only for readiness, not completion. Questions/results arrive automatically; do not poll. Children retain their conversation. Blocking answers resume work; nonblocking answers enter the conversation without restarting idle work. Model/thinking overrides apply at launch only.";

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
      || typeof record.name !== "string" || typeof record.role !== "string" || typeof record.cwd !== "string"
      || typeof record.model !== "string" || !thinkingLevels.includes(record.thinking)
      || !record.run || typeof record.run.id !== "string" || typeof record.run.state !== "string") continue;
    records.set(record.id, record);
  }
  return [...records.values()];
}

export default function sidekicks(pi: ExtensionAPI): void {
  if (process.env.PI_SIDEKICKS_CHILD) return;
  let current: { manager: Manager; widget: StatusWidget; ctx: ExtensionContext } | undefined;

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
        runtime.widget.close();
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
        }
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
        const details = { childId: child.id, runId: question?.runId ?? child.run.id, questionId: question?.id, outcome: child.run.state,
          wait: kind === "question" ? child.run.question?.id === question?.id : undefined };
        const content = `Sidekick ${kind} from ${child.name}\n${JSON.stringify(details)}\n${kind === "question" ? question!.text : child.run.result}\nChild transcript: ${child.sessionPath}`;
        pi.sendMessage({ customType: `sidekicks:${kind}`, content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
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

  pi.registerTool({
    name: "sidekick", label: "Sidekick", exposure: "model-only", description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(["launch", "send", "answer", "stop", "status"].map((value) => Type.Literal(value))),
      role: Type.Optional(Type.String()), task: Type.Optional(Type.String()), name: Type.Optional(Type.String({ maxLength: 100 })),
      model: Type.Optional(Type.String()), thinking: Type.Optional(Type.Union(thinkingLevels.map((level) => Type.Literal(level)))),
      child: Type.Optional(Type.String()), message: Type.Optional(Type.String()), questionId: Type.Optional(Type.String()), answer: Type.Optional(Type.String()),
    }),
    prepareLoadout: () => {
      if (!current) return;
      let roles = "";
      try { roles = discoverRoles(current.ctx.cwd, current.ctx.isProjectTrusted()).map((role) => `${role.name}: ${role.description.slice(0, 120)}`).join("; "); }
      catch { roles = "Role configuration error; status reports it."; }
      return { descriptions: { sidekick: `${DESCRIPTION}\nAvailable roles: ${roles || "none; add Markdown roles to ~/.pi/agent/agents/"}` } };
    },
    async execute(_id, args, signal, _update, ctx) {
      const runtime = current;
      if (!runtime || runtime.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Sidekicks session is not ready");
      const fields: Record<string, string[]> = { launch: ["role", "task", "name", "model", "thinking"],
        send: ["child", "message"], answer: ["child", "questionId", "answer"], stop: ["child"], status: [] };
      const unexpected = Object.entries(args).filter(([key, value]) => key !== "action" && value !== undefined && !fields[args.action]?.includes(key));
      if (unexpected.length) throw new Error(`Fields not supported for ${args.action}: ${unexpected.map(([key]) => key).join(", ")}. Model/thinking are launch-only.`);
      const requireText = (name: "role" | "task" | "child" | "message" | "questionId" | "answer") => {
        const value = args[name];
        if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required for ${args.action}`);
        return value;
      };
      let data: unknown;
      switch (args.action) {
        case "launch": {
          const roles = discoverRoles(ctx.cwd, ctx.isProjectTrusted());
          const role = roles.find((role) => role.name === requireText("role"));
          if (!role) throw new Error(`Unknown role. Available: ${roles.map((role) => role.name).join(", ") || "none"}`);
          const model = args.model ?? role.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
          if (!model) throw new Error("No launch, role, or parent model is available");
          data = await runtime.manager.launch({ role: role.name, instructions: role.instructions, name: args.name,
            task: requireText("task"), model, thinking: args.thinking ?? role.thinking ?? pi.getThinkingLevel() }, signal);
          break;
        }
        case "send": data = await runtime.manager.send(requireText("child"), requireText("message"), signal); break;
        case "answer": data = await runtime.manager.answer(requireText("child"), requireText("questionId"), requireText("answer"), signal); break;
        case "stop": data = await runtime.manager.stop(requireText("child")); break;
        case "status": data = { children: runtime.manager.snapshot(), roles: discoverRoles(ctx.cwd, ctx.isProjectTrusted()).map(({ instructions: _body, ...role }) => role) }; break;
        default: throw new Error("Unknown sidekick action");
      }
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });

  pi.registerShortcut("ctrl+alt+s", { description: "Collapse/expand sidekicks", handler: async () => { current?.widget.toggle(); } });
  pi.registerShortcut("ctrl+alt+n", { description: "Navigate sidekicks", handler: async (_ctx) => { if (current) await current.widget.navigate(current.ctx); } });
  pi.registerCommand("sidekicks", { description: "Inspect sidekicks without a model turn", handler: async (_args, ctx) => {
    if (!current) return;
    if (ctx.mode === "tui") await current.widget.navigate(ctx);
    else ctx.ui.notify(JSON.stringify(current.manager.snapshot()), "info");
  } });
}

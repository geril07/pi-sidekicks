import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const QUESTION_ENTRY = "sidekicks:question";
export const CHECKPOINT_ENTRY = "sidekicks:checkpoint";

export default function childExtension(pi: ExtensionAPI): void {
  if (!process.env.PI_SIDEKICKS_CHILD) return;
  let reserved: string | undefined;
  let pending: { id: string; text: string } | undefined;
  let batchTerminates = true;

  pi.registerCommand("sidekicks-restore", {
    description: "Internal restoration of a saved child conversation checkpoint",
    handler: async (args, ctx) => {
      const { leafId, requestId } = JSON.parse(args) as { leafId: string | null; requestId: string };
      if ((leafId !== null && typeof leafId !== "string") || typeof requestId !== "string" || !ctx.isIdle()) {
        throw new Error("Invalid checkpoint restoration or child is not idle");
      }
      const entries = ctx.sessionManager.getEntries();
      const target = leafId === null
        ? entries.find((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY && (entry.data as { origin?: boolean })?.origin)
        : ctx.sessionManager.getEntry(leafId);
      if (target) {
        if (target.type !== "custom" || target.customType !== CHECKPOINT_ENTRY) throw new Error("Invalid child checkpoint");
        if ((await ctx.navigateTree(target.id, { summarize: false })).cancelled) throw new Error("Child checkpoint restoration cancelled");
      } else if (leafId !== null || entries.some((entry) => entry.type === "message")) {
        throw new Error("Child checkpoint is missing; old sessions are not migrated");
      }
      pi.appendEntry(CHECKPOINT_ENTRY, { requestId, ...(!target ? { origin: true } : {}) });
    },
  });
  // These boundaries have no unresolved tool-call batch; snapshots never point into streamed output.
  const checkpoint = () => { pi.appendEntry(CHECKPOINT_ENTRY, {}); };
  pi.on("message_start", (event) => { if (event.message.role === "assistant") checkpoint(); });
  pi.on("agent_settled", checkpoint);

  pi.registerCommand("sidekicks-answer", {
    description: "Internal correlated answer delivery without starting a turn",
    handler: async (args) => {
      const { id, text } = JSON.parse(args) as { id: string; text: string };
      if (typeof id !== "string" || typeof text !== "string") throw new Error("Invalid answer");
      pi.sendMessage({ customType: "sidekicks:answer", content: `Answer to ${id}:\n${text}`,
        display: true, details: { questionId: id } }, { triggerTurn: false, deliverAs: "steer" });
      pi.appendEntry(QUESTION_ENTRY, { action: "answered", id });
    },
  });

  pi.on("before_agent_start", (event) => {
    if (pending) {
      const answered = event.messageType === "user" && event.prompt.startsWith(`Answer to ${pending.id}:\n`);
      pi.appendEntry(QUESTION_ENTRY, { action: answered ? "answered" : "cancelled", id: pending.id });
    }
    reserved = undefined;
    pending = undefined;
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    reserved = undefined;
    batchTerminates = true;
    if (ctx.hasPendingMessages()) return;
    const question = event.message.content.find((block) => block.type === "toolCall" && block.name === "ask_parent"
      && block.arguments.wait !== false);
    if (question?.type === "toolCall" && typeof question.arguments.question === "string" && question.arguments.question.trim()) {
      reserved = question.id;
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!event.parentToolCallId && event.result?.terminate !== true) batchTerminates = false;
  });

  pi.on("tool_call", (event) => {
    if (reserved && event.toolCallId !== reserved) {
      return { block: true, terminate: true, reason: "Question barrier: sibling work is deferred until the parent answers." };
    }
    if (event.toolName === "ask_parent" && (event.parentToolCallId || (event.input.wait !== false && event.toolCallId !== reserved))) {
      return { block: true, reason: "Call ask_parent directly, alone, after reading any queued parent guidance." };
    }
  });

  pi.registerTool({
    name: "ask_parent", label: "Ask parent", exposure: "model-only",
    description: "Ask the parent a question only when blocked on something only the parent can decide; do not reconfirm an adequate task. wait defaults to true: call directly, alone, and pause until answered. Set wait:false to ask and continue; replies enter this conversation without restarting idle work.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }), wait: Type.Optional(Type.Boolean()) }),
    async execute(toolCallId, { question, wait = true }) {
      if (!wait) {
        if (!question.trim()) throw new Error("Question must not be blank");
        const entry = { id: randomUUID().slice(0, 8), text: question.trim(), wait: false };
        pi.appendEntry(QUESTION_ENTRY, { action: "asked", ...entry });
        return { content: [{ type: "text", text: "Question sent. Continue working; the reply will enter this conversation." }], details: entry };
      }
      if (pending || reserved !== toolCallId || !question.trim()) throw new Error("No valid question reservation");
      pending = { id: randomUUID().slice(0, 8), text: question.trim() };
      pi.appendEntry(QUESTION_ENTRY, { action: "asked", ...pending });
      return { content: [{ type: "text", text: "Waiting for the parent's answer." }], details: pending, terminate: true };
    },
  });

  pi.on("turn_end", (_event, ctx) => {
    checkpoint();
    if (!pending) return;
    if (ctx.hasPendingMessages() || !batchTerminates) {
      pi.appendEntry(QUESTION_ENTRY, { action: "withdrawn", id: pending.id });
      pending = undefined;
      reserved = undefined;
      return { entries: [{ type: "custom_message", customType: QUESTION_ENTRY, display: false,
        content: "The question was withdrawn: parent guidance arrived or this tool batch could not terminate cleanly. Read the guidance/errors, then call ask_parent alone only if still blocked." }] };
    }
    ctx.abort();
  });
  pi.on("agent_before_settle", (_event, ctx) => { if (pending) ctx.abort(); });
  pi.on("session_shutdown", () => {
    if (pending) pi.appendEntry(QUESTION_ENTRY, { action: "cancelled", id: pending.id });
    pending = undefined;
  });
}

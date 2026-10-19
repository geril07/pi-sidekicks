import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";

export default function fixture(pi: ExtensionAPI): void {
  const log = (event: object) => appendFileSync(process.env.SIDEKICKS_TEST_LOG!, `${JSON.stringify(event)}\n`);
  const faux = fauxProvider({ provider: "sidekicks-test", models: [{ id: "scripted", reasoning: true }], tokensPerSecond: 0 });
  pi.registerProvider(faux.provider);
  const scenario = process.env.SIDEKICKS_TEST_SCENARIO ?? "pause";
  const next = scenario === "model-switch" ? fauxProvider({ provider: "sidekicks-next", models: [{ id: "alternate", reasoning: true }], tokensPerSecond: 0 }) : undefined;
  if (next) pi.registerProvider(next.provider);
  pi.registerCommand("qa-reload", { description: "Test-only reload", handler: async (_args, ctx) => { await ctx.reload(); } });
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, "ctrl+alt+d")) {
        void ctx.ui.input("QA unrelated dialog", "type here").then((value) => ctx.ui.notify(`QA dialog result: ${value}`, "info"));
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+alt+q")) { ctx.shutdown(); return { consume: true }; }
    });
  });
  pi.on("session_shutdown", () => { unsubscribe?.(); });
  if (!process.env.PI_SIDEKICKS_CHILD) {
    const record = (event: string) => appendFileSync(`${process.env.SIDEKICKS_TEST_LOG!}.events`, `${event}\n`);
    pi.events.on("herdr:busy", (data) => record(`busy:${(data as { active: boolean }).active}`));
    pi.on("agent_start", () => record("agent_start"));
    pi.on("agent_settled", () => record("agent_settled"));
  }
  let queued = false;
  let continuation = false;
  const answered = new Set<string>();
  pi.on("agent_before_settle", () => {
    if (scenario === "continuation" && !continuation) { continuation = true; return { continue: true }; }
  });
  pi.on("message_end", (event) => {
    if (!queued && scenario === "withdraw" && event.message.role === "assistant") {
      queued = true;
      pi.sendUserMessage("Parent guidance: continue", { deliverAs: "steer" });
    }
  });
  pi.registerTool({ name: "effect", label: "Effect", parameters: Type.Object({}), executionMode: process.env.SIDEKICKS_TEST_SEQUENTIAL ? "sequential" : "parallel",
    description: "Test-only side effect",
    async execute(_id, _args, signal) {
      log({ effect: true });
      if (scenario === "nonblocking" && process.env.SIDEKICKS_TEST_GATE) {
        while (!existsSync(process.env.SIDEKICKS_TEST_GATE)) await delay(10, undefined, { signal });
      }
      return { content: [{ type: "text", text: "effect" }], details: undefined };
    },
  });
  pi.registerTool({ name: "nested_question", label: "Nested question", parameters: Type.Object({}), description: "Test nested invocation",
    async execute(_id, _args, _signal, _update, ctx) {
      const result = await ctx.executeTool("ask_parent", { question: "Nested question?" });
      log({ nestedRejected: result.isError });
      return { content: [{ type: "text", text: "Nested invocation rejected" }], details: result };
    },
  });
  pi.registerTool({ name: "human_dialogs", label: "Human dialogs", parameters: Type.Object({}), description: "Test child extension dialogs",
    async execute(_id, _args, _signal, _update, ctx) {
      ctx.ui.notify("QA child toast", "info");
      const confirmed = await ctx.ui.confirm("QA confirm", "Explicit human choice", { timeout: 10_000 });
      const selected = await ctx.ui.select("QA select", ["A", "B"], { timeout: 10_000 });
      const input = await ctx.ui.input("QA input", "type here", { timeout: 10_000 });
      const edited = await ctx.ui.editor("QA editor", "prefill");
      log({ dialogs: { confirmed, selected, input, edited } });
      return { content: [{ type: "text", text: "Dialogs complete" }], details: { confirmed, selected, input, edited } };
    },
  });
  const script = async (context: TranscriptContext, _options: unknown, state: { callCount: number }) => {
    log({ call: state.callCount, child: process.env.PI_SIDEKICKS_CHILD ?? "parent", cwd: process.cwd(),
      lastUser: context.messages.filter((message) => message.role === "user").at(-1)?.content,
      transcript: ["nonblocking", "model-switch"].includes(scenario) ? JSON.stringify(context.messages) : undefined });
    if (scenario === "model-switch") {
      const textOf = (message: TranscriptContext["messages"][number]) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (process.env.PI_SIDEKICKS_CHILD) {
        const lastUser = context.messages.filter((message) => message.role === "user").at(-1);
        return lastUser && textOf(lastUser).includes("FAIL_QUOTA")
          ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic quota exhausted" })
          : fauxAssistantMessage("Saved work: CODEWORD. Continued with the prior conversation.");
      }
      const request = context.messages.findLastIndex((message) => message.role === "user" && textOf(message).startsWith("MODEL_CALL "));
      if (request >= 0 && !context.messages.slice(request + 1).some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === "subagent"))) {
        return fauxAssistantMessage(fauxToolCall("subagent", JSON.parse(textOf(context.messages[request]).slice("MODEL_CALL ".length))), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Parent received the tool response or child delivery.");
    }
    if (scenario === "batch-parent") {
      if (process.env.PI_SIDEKICKS_CHILD && process.env.SIDEKICKS_TEST_GATE) {
        while (!existsSync(process.env.SIDEKICKS_TEST_GATE)) await delay(10);
      }
      if (process.env.PI_SIDEKICKS_CHILD) return fauxAssistantMessage(`Batch child full result.\n${"Detail ".repeat(40)}\nEvidence: local scripted provider.`);
      if (state.callCount === 1) return fauxAssistantMessage(fauxToolCall("subagent", {
        action: "launch", ...JSON.parse(process.env.SIDEKICKS_TEST_LAUNCH!),
      }), { stopReason: "toolUse" });
      return fauxAssistantMessage("FINAL: batch tool response or delivery received.");
    }
    if (scenario === "mixed-questions" && state.callCount <= 2) {
      return fauxAssistantMessage(fauxToolCall("ask_parent", { question: `Question ${state.callCount}?`, wait: state.callCount === 2 }), { stopReason: "toolUse" });
    }
    if (["orchestrator", "dialogs", "nonblocking-parent"].includes(scenario) && !process.env.PI_SIDEKICKS_CHILD) {
      if (state.callCount === 1) return fauxAssistantMessage(fauxToolCall("subagent", {
        action: "launch", agent: "worker", task: "Ask which option, then finish",
        ...JSON.parse(process.env.SIDEKICKS_TEST_LAUNCH ?? '{"model":"sidekicks-test/scripted","thinking":"low"}'),
      }), { stopReason: "toolUse" });
      const text = context.messages.map((message) => JSON.stringify(message)).join("\n");
      const questions = [...text.matchAll(/Sidekick (\S+) asks \(question (\w+)/g)];
      const question = questions.at(-1);
      if (question && !answered.has(question[2])) {
        answered.add(question[2]);
        return fauxAssistantMessage(fauxToolCall("subagent", { action: "answer", child: question[1], questionId: question[2], answer: "Choose A" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(/Sidekick \S+ completed/.test(text) ? "FINAL: child completion received automatically." : "Parent remains usable while the child works.");
    }
    if (scenario === "reopen" && context.messages.some((message) => message.role === "assistant") && state.callCount === 1) {
      return fauxAssistantMessage("Reopened with the earlier conversation.");
    }
    if (["queued", "followup"].includes(scenario) && state.callCount === 1) pi.sendUserMessage("Parent guidance: continue", { deliverAs: scenario === "followup" ? "followUp" : "steer" });
    if (state.callCount === 1) {
      if (scenario === "dialogs") return fauxAssistantMessage(fauxToolCall("human_dialogs", {}), { stopReason: "toolUse" });
      const names = JSON.parse(process.env.SIDEKICKS_TEST_BATCH ?? '["effect","ask_parent","effect"]') as string[];
      return fauxAssistantMessage(names.map((name, i) => fauxToolCall(name,
        name === "ask_parent" ? { question: scenario === "malformed" ? "" : "Which option?",
          ...(["nonblocking", "nonblocking-parent"].includes(scenario) ? { wait: false } : scenario === "explicit-wait" ? { wait: true } : {}) } : {}, { id: `call-${i}` })), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`Continued in the same conversation (${state.callCount}).`);
  };
  faux.setResponses(Array.from({ length: scenario === "model-switch" ? 60 : 12 }, () => script));
  next?.setResponses(Array.from({ length: 12 }, () => script));
}

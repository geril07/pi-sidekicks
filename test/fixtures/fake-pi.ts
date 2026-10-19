import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.SIDEKICKS_FAKE_SCENARIO ?? "hold";
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
let model = { provider: "local", id: "scripted" };
let thinkingLevel = "off";
let prompts = 0;
let contextTokens: number | null = 0;
let statsRequests = 0;
const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const settled = () => emit({ type: "agent_settled", aborted: false });
const complete = () => {
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
  settled();
};
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "extension_ui_response") return;
  const response = (data?: unknown) => emit({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_available_models": {
      if (mode === "invalid") { process.stdout.write("not JSON\n"); return; }
      const respond = () => response({ models: mode === "catalog" ? [{ provider: "openai", id: "luna" }, { provider: "codex", id: "luna" }, { provider: "gateway", id: "openai/luna" }] : [model] });
      if (mode === "slow") setTimeout(respond, 100);
      else respond();
      break;
    }
    case "set_model": model = { provider: command.provider, id: command.modelId }; response(model); break;
    case "get_available_thinking_levels": response({ levels: ["off", "low"] }); break;
    case "set_thinking_level": thinkingLevel = command.level; response(); break;
    case "get_state": {
      const state = { model, thinkingLevel, sessionFile: arg("--session"), isStreaming: prompts > 0 };
      if (mode === "out-of-order") setTimeout(() => response(state), 30);
      else response(state);
      break;
    }
    case "get_session_stats": {
      statsRequests++;
      if (mode === "metrics-unavailable") {
        emit({ type: "response", id: command.id, command: command.type, success: false, error: "Stats unavailable" });
        break;
      }
      const data = { contextUsage: { tokens: contextTokens, contextWindow: 200000, percent: contextTokens === null ? null : contextTokens / 2000 } };
      if (mode === "metrics-race" && statsRequests === 2) setTimeout(() => response(data), 100);
      else response(data);
      break;
    }
    case "get_last_assistant_text": {
      if (mode === "settling-race") setTimeout(() => response({ text: "done" }), 2000);
      else response({ text: mode === "long-result" ? "x".repeat(30_000) : "done" });
      break;
    }
    case "clear_queue": response({ steering: [], followUp: [] }); break;
    case "abort": emit({ type: "agent_settled", aborted: true }); response(); break;
    case "prompt": {
      prompts++;
      if (process.env.SIDEKICKS_FAKE_LOG) appendFileSync(process.env.SIDEKICKS_FAKE_LOG, `${JSON.stringify({ ...command, cwd: process.cwd(), subagentChild: process.env.PI_SUBAGENT_CHILD, subagentAgent: process.env.PI_SUBAGENT_CHILD_AGENT })}\n`);
      response({ disposition: "started" });
      if (mode === "metrics" || mode === "metrics-unavailable") setImmediate(() => {
        for (const toolCallId of ["outer", "outer/1"]) {
          emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: {} });
          emit({ type: "tool_execution_end", toolCallId, toolName: "read", isError: true });
        }
        contextTokens = 42000;
        emit({ type: "turn_end" });
        emit({ type: "turn_end" });
        complete();
      });
      if (mode === "metrics-race") setImmediate(() => {
        contextTokens = 42000;
        emit({ type: "turn_end" });
        setTimeout(() => {
          contextTokens = null;
          emit({ type: "compaction_start", reason: "threshold" });
          emit({ type: "compaction_end", reason: "threshold" });
        }, 20);
        setTimeout(() => {
          contextTokens = 5000;
          emit({ type: "turn_end" });
          complete();
        }, 200);
      });
      if (mode === "complete" || mode === "long-result" || mode === "settling-race" || (mode === "batch" && command.message.includes("outcome=complete"))) setImmediate(complete);
      if (mode === "exit" || (mode === "batch" && command.message.includes("outcome=exit"))) setImmediate(() => process.exit(0));
      if (mode === "question" && prompts === 1) setImmediate(() => {
        const event = { type: "entry_appended", entry: { type: "custom", customType: "sidekicks:question",
          data: { action: "asked", id: "question-1", text: "Which option?" } } };
        emit(event);
        emit(event);
        settled();
      });
      if (mode === "question" && prompts > 1) setImmediate(complete);
      if (mode === "failure" || (mode === "batch" && command.message.includes("outcome=failure"))) setImmediate(() => {
        emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "scripted provider failed" } });
        settled();
      });
      if (mode === "unexplained-abort") setImmediate(() => {
        emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "remote abort" } });
        emit({ type: "agent_settled", aborted: true });
      });
      if (mode === "descendant") {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(process.env.SIDEKICKS_DESCENDANT_PID!, String(descendant.pid));
      }
      break;
    }
    default: response();
  }
});

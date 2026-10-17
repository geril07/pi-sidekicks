import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { RpcConnection, type RpcEvent } from "../src/rpc.ts";
import { Manager, type ChildRecord, type ChildSnapshot } from "../src/manager.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

async function isolated(scenario: string) {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-e2e-");
  const agent = join(dir, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(agent, "agents"));
  await symlink(resolve("test/fixtures/faux-provider.ts"), join(agent, "extensions", "faux-provider.ts"));
  await writeFile(join(agent, "agents", "worker.md"), "---\nname: worker\ndescription: Test worker\n---\nComplete the delegated task.\n");
  const log = join(dir, "calls.jsonl");
  return { dir, agent, log, env: { ...process.env, PI_CODING_AGENT_DIR: agent,
    SIDEKICKS_TEST_LOG: log, SIDEKICKS_TEST_SCENARIO: scenario } };
}

test("real parent extension launches, receives a question, answers, and gets completion without polling", { timeout: 30_000 }, async (t) => {
  const h = await isolated("orchestrator");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
    { cwd: h.dir, env: h.env });
  t.after(() => rpc.stop());
  const events: RpcEvent[] = [];
  let finalSeen = false;
  const done = new Promise<void>((resolve) => {
    rpc.on("event", (event: RpcEvent) => {
      events.push(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalSeen ||= event.message.content.some((block) => block.type === "text" && block.text.includes("FINAL:"));
      }
      if (event.type === "agent_settled" && finalSeen) resolve();
    });
  });
  await rpc.request({ type: "get_state" });
  await rpc.request({ type: "prompt", message: "Delegate the task to a worker. Answer any question and report completion." });
  await done;
  const entries = (await rpc.request({ type: "get_entries" })).entries;
  const notifications = entries.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"));
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].type === "custom_message" && notifications[0].customType, "sidekicks:question");
  assert.equal(notifications[1].type === "custom_message" && notifications[1].customType, "sidekicks:result");
  const toolCalls = events.filter((event) => event.type === "tool_execution_start");
  assert.equal(toolCalls.length, 2, "only launch and answer, never a polling call");
  const records = entries.filter((entry) => entry.type === "custom" && entry.customType === "sidekicks:state");
  const last = records.at(-1);
  assert(last?.type === "custom");
  const child = last.data as ChildRecord;
  assert.equal(child.run.state, "completed");
  assert.equal(child.model, "sidekicks-test/scripted");
  assert.equal(child.thinking, "low");
  const transcript = await readFile(child.sessionPath, "utf8");
  assert.match(transcript, /Sidekicks answer to/);
  assert.match(transcript, /"action":"answered"/);
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.filter((record) => record.child === child.id && record.call).length, 2);
  assert.equal(calls.filter((record) => record.effect).length, 0);
  await rpc.request({ type: "prompt", message: "/qa-reload" });
  assert.equal((await rpc.request({ type: "get_state" })).isStreaming, false);
  const afterReload = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(afterReload.filter((record) => record.call).length, calls.filter((record) => record.call).length,
    "reload must not replay assignments or notifications");
  await rpc.request({ type: "new_session" });
});

test("real child reopens its persisted conversation, loading ambient extensions again", { timeout: 30_000 }, async (t) => {
  const h = await isolated("reopen");
  const deliveries: ChildSnapshot[] = [];
  let resolveDelivery: (() => void) | undefined;
  const manager = new Manager({ ownerSessionId: "real-parent", directory: join(h.dir, "children"), cwd: h.dir, trusted: false,
    invocation: { command: process.execPath, args: [cli] }, env: h.env,
    persist() {}, changed() {}, dialog: async () => undefined,
    deliver: (child) => { deliveries.push(child); resolveDelivery?.(); },
  });
  t.after(() => manager.shutdown());
  const nextDelivery = () => new Promise<void>((resolve) => { resolveDelivery = resolve; });
  let delivered = nextDelivery();
  const child = await manager.launch({ role: "worker", instructions: "Work", task: "Ask", model: "sidekicks-test/scripted", thinking: "low" });
  await delivered;
  const question = deliveries.at(-1)!.run.question!;
  delivered = nextDelivery();
  await manager.answer(child.id, question.id, "Choose A");
  await delivered;
  assert.equal(deliveries.at(-1)!.run.state, "completed");
  const before = (await readFile(child.sessionPath, "utf8")).split("\n")[0];
  await manager.stop(child.id);
  delivered = nextDelivery();
  await manager.send(child.id, "Recall the earlier assignment");
  await delivered;
  const result = deliveries.at(-1)!;
  assert.equal(result.run.state, "completed");
  assert.match(result.run.result!, /Reopened with the earlier conversation/);
  assert.equal(result.sessionPath, child.sessionPath);
  assert.equal((await readFile(child.sessionPath, "utf8")).split("\n")[0], before);
});

test("real child extension dialogs bridge to the human client without auto-approval", { timeout: 30_000 }, async (t) => {
  const h = await isolated("dialogs");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
    { cwd: h.dir, env: h.env });
  t.after(() => rpc.stop());
  const dialogs: string[] = [];
  const warnings: string[] = [];
  let finalSeen = false;
  const done = new Promise<void>((resolve) => {
    rpc.on("event", (event: RpcEvent) => {
      if (event.type === "extension_ui_request") {
        if (event.method === "notify") warnings.push(event.message);
        if (event.method === "confirm") { dialogs.push(event.method); rpc.respond({ type: "extension_ui_response", id: event.id, confirmed: false }); }
        if (event.method === "select") { dialogs.push(event.method); rpc.respond({ type: "extension_ui_response", id: event.id, value: "B" }); }
        if (event.method === "input") { dialogs.push(event.method); rpc.respond({ type: "extension_ui_response", id: event.id, value: "qa-value" }); }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalSeen ||= event.message.content.some((block) => block.type === "text" && block.text.includes("FINAL:"));
      }
      if (event.type === "agent_settled" && finalSeen) resolve();
    });
  });
  await rpc.request({ type: "prompt", message: "Delegate to the worker and relay its human dialogs." });
  await done;
  assert.deepEqual(dialogs, ["confirm", "select", "input"]);
  assert(warnings.some((warning) => warning.includes("multiline editor bridging requires a TUI parent")));
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const result = calls.find((call) => call.dialogs)?.dialogs;
  assert.deepEqual(result, { confirmed: false, selected: "B", input: "qa-value" });
  await rpc.request({ type: "new_session" });
});

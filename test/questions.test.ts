import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { RpcConnection, type RpcEvent } from "../src/rpc.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const cases = [
  { scenario: "pause", batch: ["effect", "ask_parent", "effect"], paused: true, effects: 0 },
  { scenario: "pause", batch: ["ask_parent", "effect", "effect"], paused: true, effects: 0 },
  { scenario: "pause", batch: ["effect", "effect", "ask_parent"], paused: true, effects: 0 },
  { scenario: "pause", batch: ["ask_parent", "ask_parent", "effect"], paused: true, effects: 0 },
  { scenario: "queued", batch: ["effect", "ask_parent", "effect"], paused: false, effects: 2 },
  { scenario: "withdraw", batch: ["effect", "ask_parent", "effect"], paused: false, effects: 0 },
  { scenario: "followup", batch: ["effect", "ask_parent", "effect"], paused: false, effects: 2 },
  { scenario: "malformed", batch: ["effect", "ask_parent", "effect"], paused: false, effects: 2 },
  { scenario: "unknown", batch: ["unknown_tool", "ask_parent", "effect"], paused: false, effects: 0 },
  { scenario: "nested", batch: ["nested_question"], paused: false, effects: 0 },
  { scenario: "continuation", batch: ["ask_parent", "effect"], paused: true, effects: 0 },
  { scenario: "sequential", batch: ["effect", "ask_parent", "effect"], paused: true, effects: 0 },
];
for (const { scenario, batch, paused, effects } of cases) {
  test(`real Pi question barrier: ${scenario} [${batch.join(", ")}]`, { timeout: 30_000 }, async (t) => {
    const dir = await mkdtemp("/tmp/opencode/sidekicks-proof-");
    await mkdir(join(dir, "agent"));
    const log = join(dir, "calls.jsonl");
    const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-extensions",
      "--no-skills", "--no-prompt-templates", "--no-approve", "--session", join(dir, "child.jsonl"),
      "-e", resolve("src/child.ts"), "-e", resolve("test/fixtures/faux-provider.ts"),
      "--model", "sidekicks-test/scripted"] }, {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SIDEKICKS_CHILD: "proof",
        SIDEKICKS_TEST_LOG: log, SIDEKICKS_TEST_SCENARIO: scenario, SIDEKICKS_TEST_BATCH: JSON.stringify(batch),
        SIDEKICKS_TEST_SEQUENTIAL: scenario === "sequential" ? "1" : "" },
    });
    t.after(() => rpc.stop());
    const events: RpcEvent[] = [];
    rpc.on("event", (event: RpcEvent) => { events.push(event); if (event.type === "agent_settled") rpc.emit("settled"); });
    const settled = once(rpc, "settled");
    await rpc.request({ type: "get_state" });
    await rpc.request({ type: "prompt", message: "Task: ask the parent" });
    await settled;
    const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const messages = (await rpc.request({ type: "get_messages" })).messages;
    assert(!messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"));
    assert.equal(messages.filter((message) => message.role === "toolResult").length, batch.length);
    assert.equal(records.filter((r) => r.effect).length, effects);
    if (paused) {
      assert.equal(records.filter((r) => r.call).length, 1);
      assert.equal(records.filter((r) => r.effect).length, 0);
      const next = once(rpc, "settled");
      await rpc.request({ type: "prompt", message: "Sidekicks follow-up: choose A" });
      await next;
      assert.match((await rpc.request({ type: "get_last_assistant_text" })).text ?? "", /same conversation \(2\)/);
    } else {
      assert.equal(records.filter((r) => r.call).length, scenario === "followup" ? 3 : 2);
      if (scenario === "nested") assert.equal(records.find((r) => "nestedRejected" in r)?.nestedRejected, true);
    }
  });
}

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { RpcConnection } from "../src/rpc.ts";

test("RPC correlates responses when the child answers out of order", async (t) => {
  const rpc = new RpcConnection({ command: process.execPath, args: [resolve("test/fixtures/fake-pi.ts"), "--session", "/test.jsonl"] },
    { cwd: process.cwd(), env: { ...process.env, SIDEKICKS_FAKE_SCENARIO: "out-of-order" } });
  t.after(() => rpc.stop());
  const first = rpc.request({ type: "get_state" });
  const models = await rpc.request({ type: "get_available_models" });
  assert.equal(models.models[0].id, "scripted");
  assert.equal((await first).sessionFile, "/test.jsonl");
});

for (const scenario of ["type-first", "type-last"]) {
  for (const size of [10 * 1024 * 1024, 64 * 1024 * 1024]) {
    test(`RPC accepts agent_end at ${size} code units (${scenario}) and remains usable`, async (t) => {
      const rpc = new RpcConnection({ command: process.execPath,
        args: [resolve("test/fixtures/rpc-large-event.ts"), scenario, String(size)] }, { cwd: process.cwd() });
      t.after(() => rpc.stop());
      const events: string[] = [];
      const faults: Error[] = [];
      rpc.on("event", (event) => {
        events.push(event.type);
        if (event.type === "agent_end") assert.equal(event.messages.length, 1);
      });
      rpc.on("fault", (error) => faults.push(error));
      assert.equal((await rpc.request({ type: "get_state" })).sessionFile, "/test.jsonl");
      assert.deepEqual(events, ["agent_end", "agent_settled"]);
      assert.deepEqual(faults, []);
      assert.equal((await rpc.request({ type: "get_state" })).sessionFile, "/test.jsonl");
    });
  }
}

for (const scenario of ["type-first", "other", "no-lf"]) {
  test(`RPC rejects a record one code unit above the limit (${scenario})`, async (t) => {
    const rpc = new RpcConnection({ command: process.execPath,
      args: [resolve("test/fixtures/rpc-large-event.ts"), scenario, String(64 * 1024 * 1024 + 1)] }, { cwd: process.cwd() });
    t.after(() => rpc.stop());
    await assert.rejects(rpc.request({ type: "get_state" }), /RPC line exceeds 64 Mi UTF-16 code units/);
  });
}

test("RPC rejects malformed JSON even when it starts with agent_end", async (t) => {
  const rpc = new RpcConnection({ command: process.execPath,
    args: [resolve("test/fixtures/rpc-large-event.ts"), "invalid"] }, { cwd: process.cwd() });
  t.after(() => rpc.stop());
  await assert.rejects(rpc.request({ type: "get_state" }), /invalid RPC JSON/);
});

test("spawn failure rejects outstanding RPC instead of waiting for its deadline", async (t) => {
  const rpc = new RpcConnection({ command: "/nonexistent-sidekicks-pi", args: [] }, { cwd: process.cwd() });
  t.after(() => rpc.stop());
  await assert.rejects(rpc.request({ type: "get_state" }), /ENOENT|closed/);
});

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

test("spawn failure rejects outstanding RPC instead of waiting for its deadline", async (t) => {
  const rpc = new RpcConnection({ command: "/nonexistent-sidekicks-pi", args: [] }, { cwd: process.cwd() });
  t.after(() => rpc.stop());
  await assert.rejects(rpc.request({ type: "get_state" }), /ENOENT|closed/);
});

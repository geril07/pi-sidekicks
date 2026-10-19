import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { RpcConnection } from "../src/rpc.ts";
import type { ChildRecord, ChildSnapshot } from "../src/manager.ts";

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 15_000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    assert(performance.now() < deadline, "Lifecycle transition timed out");
    await delay(15);
  }
}
const entries = async (rpc: RpcConnection) => (await rpc.request({ type: "get_entries" })).entries;
const idle = (rpc: RpcConnection) => waitFor(() => rpc.request({ type: "get_state" }),
  (state) => !state.isStreaming && !state.isCompacting && !state.pendingMessageCount);
const records = async (rpc: RpcConnection) => (await entries(rpc)).filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === "sidekicks:state");
const childState = (rpc: RpcConnection, ready: (record: ChildRecord) => boolean) => waitFor(async () => (await records(rpc)).at(-1),
  (entry) => !!entry && ready(entry.data as ChildRecord));
async function invoke(rpc: RpcConnection, args: object) {
  await idle(rpc);
  const count = (await entries(rpc)).length;
  await rpc.request({ type: "prompt", message: `MODEL_CALL ${JSON.stringify(args)}` });
  const result = await waitFor(async () => (await entries(rpc)).slice(count).find((entry) => entry.type === "message"
    && entry.message.role === "toolResult" && entry.message.toolName === "subagent"), (entry) => !!entry);
  await idle(rpc);
  assert(result?.type === "message" && result.message.role === "toolResult");
  return result.message;
}
const status = async (rpc: RpcConnection) => ((await invoke(rpc, { action: "status" })).details as unknown as { children: ChildSnapshot[] }).children;
async function tree(rpc: RpcConnection, target: string) {
  await idle(rpc);
  await rpc.request({ type: "prompt", message: `/qa-tree ${target}` });
  await idle(rpc);
}
async function harness(t: TestContext, scenario = "lifecycle") {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-lifecycle-");
  const agent = join(dir, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(agent, "sidekicks"));
  await symlink(resolve("test/fixtures/faux-provider.ts"), join(agent, "extensions", "provider.ts"));
  await writeFile(join(agent, "sidekicks", "worker.md"), "---\nname: worker\ndescription: Test worker\n---\nComplete the delegated task.\n");
  const file = join(dir, "parent.jsonl");
  const gate = join(dir, "release");
  const log = join(dir, "calls.jsonl");
  const connect = (mode = scenario, fork = false) => {
    const rpc = new RpcConnection({ command: process.execPath, args: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      "--mode", "rpc", "--no-approve", fork ? "--fork" : "--session", file,
      "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
    { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agent, SIDEKICKS_TEST_LOG: log,
      SIDEKICKS_TEST_SCENARIO: mode, SIDEKICKS_TEST_GATE: gate,
      SIDEKICKS_TEST_LAUNCH: JSON.stringify({ agent: "worker", task: "Hold until released", name: "one" }) } });
    t.after(() => rpc.stop());
    return rpc;
  };
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { dir, agent, file, gate, calls, connect };
}

test("real tree restoration branches the child's context and never replaces earlier task/result files", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const rpc = h.connect();
  assert.equal((await invoke(rpc, { action: "launch", agent: "worker", name: "one", task: "A_ONLY" })).isError, false);
  const checkpointA = await childState(rpc, (record) => record.run.state === "completed" && record.run.delivered);
  assert(checkpointA);
  await idle(rpc);
  assert.equal((await invoke(rpc, { action: "send", child: "one", message: "B_ONLY" })).isError, false);
  const checkpointB = await childState(rpc, (record) => record.run.number === 2 && record.run.state === "completed" && record.run.delivered);
  assert(checkpointB);
  await idle(rpc);
  const child = checkpointB.data as ChildRecord;
  const folder = dirname(child.sessionPath);
  const taskB = await readFile(join(folder, "task-2.md"), "utf8");
  const resultB = await readFile(join(folder, "result-2.md"), "utf8");
  const callCount = (await h.calls()).filter((call) => call.child !== "parent").length;
  await tree(rpc, checkpointA.id);
  assert.equal((await status(rpc))[0].run.number, 1);
  assert.equal((await h.calls()).filter((call) => call.child !== "parent").length, callCount, "restore must not call the child model");
  assert.equal((await invoke(rpc, { action: "send", child: "one", message: "C_ONLY" })).isError, false);
  await childState(rpc, (record) => record.run.number === 3 && record.run.state === "completed" && record.run.delivered);
  const c = (await h.calls()).filter((call) => call.child !== "parent").at(-1);
  assert.match(c.transcript, /A_ONLY/);
  assert.match(c.transcript, /C_ONLY/);
  assert.doesNotMatch(c.transcript, /B_ONLY/);
  assert.equal(await readFile(join(folder, "task-2.md"), "utf8"), taskB);
  assert.equal(await readFile(join(folder, "result-2.md"), "utf8"), resultB);
  assert.match(await readFile(join(folder, "result-3.md"), "utf8"), /C_ONLY/);
  await tree(rpc, checkpointB.id);
  assert.equal((await status(rpc))[0].run.number, 2);
  assert.equal((await invoke(rpc, { action: "send", child: "one", message: "D_ONLY" })).isError, false);
  await childState(rpc, (record) => record.run.number === 4 && record.run.state === "completed" && record.run.delivered);
  const d = (await h.calls()).filter((call) => call.child !== "parent").at(-1);
  assert.match(d.transcript, /B_ONLY/);
  assert.doesNotMatch(d.transcript, /C_ONLY/);
});

test("real tree no-op keeps a waiting child; actual navigation releases it and cancels stale answers", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const rpc = h.connect();
  await invoke(rpc, { action: "launch", agent: "worker", name: "one", task: "WAIT_TEST" });
  const waiting = await childState(rpc, (record) => record.run.state === "waiting" && !!record.run.question?.delivered);
  assert(waiting);
  await idle(rpc);
  const saved = waiting.data as ChildRecord;
  const lock = `${saved.sessionPath}.lock`;
  await tree(rpc, "current");
  assert.equal((await status(rpc))[0].run.state, "waiting");
  assert(await stat(lock));
  const firstUser = (await entries(rpc)).find((entry) => entry.type === "message" && entry.message.role === "user");
  assert(firstUser);
  await tree(rpc, firstUser.id);
  assert.deepEqual(await status(rpc), []);
  await assert.rejects(stat(lock), { code: "ENOENT" });
  await tree(rpc, waiting.id);
  const restored = (await status(rpc))[0];
  assert.equal(restored.run.state, "interrupted");
  assert.equal(restored.run.question, undefined);
  assert.equal((await invoke(rpc, { action: "answer", child: "one", questionId: saved.run.question!.id, answer: "Late" })).isError, true);
  assert.equal((await invoke(rpc, { action: "send", child: "one", message: "AFTER_WAIT" })).isError, false);
  await childState(rpc, (record) => record.run.number === 2 && record.run.state === "completed");
});

test("restoring an in-flight snapshot excludes its unfinished tool batch but keeps the original task", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const rpc = h.connect();
  await invoke(rpc, { action: "launch", agent: "worker", name: "one", task: "INFLIGHT_TEST" });
  const running = await childState(rpc, (record) => record.run.state === "running" && record.run.tools === 1);
  assert(running);
  await status(rpc);
  await tree(rpc, running.id);
  assert.equal((await status(rpc))[0].run.state, "interrupted");
  assert.equal((await invoke(rpc, { action: "send", child: "one", message: "AFTER_INFLIGHT" })).isError, false);
  await childState(rpc, (record) => record.run.number === 2 && record.run.state === "completed");
  const call = (await h.calls()).filter((item) => item.child !== "parent").at(-1);
  assert.match(call.transcript, /INFLIGHT_TEST/);
  assert.match(call.transcript, /AFTER_INFLIGHT/);
  assert.doesNotMatch(call.transcript, /"type":"toolCall"/);
});

for (const action of ["clone", "fork"] as const) {
  test(`same-window ${action} stops its own child and does not adopt it into the new session`, { timeout: 30_000 }, async (t) => {
    const h = await harness(t, "batch-parent");
    const rpc = h.connect();
    await rpc.request({ type: "prompt", message: "Launch one" });
    const running = await childState(rpc, (record) => record.run.state === "running");
    assert(running);
    await idle(rpc);
    const child = running.data as ChildRecord;
    if (action === "clone") await rpc.request({ type: "clone" });
    else {
      const user = (await entries(rpc)).find((entry) => entry.type === "message" && entry.message.role === "user");
      assert(user);
      await rpc.request({ type: "fork", entryId: user.id });
    }
    await idle(rpc);
    await assert.rejects(stat(`${child.sessionPath}.lock`), { code: "ENOENT" });
    let notice = "";
    rpc.on("event", (event) => { if (event.type === "extension_ui_request" && event.method === "notify") notice = event.message; });
    await rpc.request({ type: "prompt", message: "/sidekicks" });
    assert.match(notice, /No children yet/);
    await rpc.request({ type: "switch_session", sessionPath: h.file });
    await idle(rpc);
    const latest = (await records(rpc)).at(-1)!.data as ChildRecord;
    assert.equal(latest.run.state, "interrupted");
  });
}

test("another window can explicitly continue its saved checkpoint after the owner releases the child", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const a = h.connect();
  await invoke(a, { action: "launch", agent: "worker", name: "one", task: "OWNER_TASK" });
  await childState(a, (record) => record.run.state === "completed" && record.run.delivered);
  await idle(a);
  const b = h.connect();
  assert.equal((await status(b))[0].external, true);
  await a.request({ type: "new_session" });
  assert.equal((await status(b))[0].external, undefined);
  assert.equal((await invoke(b, { action: "send", child: "one", message: "NEW_OWNER_TASK" })).isError, false);
  await childState(b, (record) => record.run.number === 2 && record.run.state === "completed");
  const last = (await h.calls()).filter((call) => call.child !== "parent").at(-1);
  assert.match(last.transcript, /OWNER_TASK/);
  assert.match(last.transcript, /NEW_OWNER_TASK/);
});

test("two real parent windows do not mutate, answer, stop, deliver, or shut down each other's child", { timeout: 30_000 }, async (t) => {
  const h = await harness(t, "batch-parent");
  const a = h.connect();
  await a.request({ type: "prompt", message: "Launch one child" });
  const running = await childState(a, (record) => record.run.state === "running");
  assert(running);
  await idle(a);
  const child = running.data as ChildRecord;
  const folder = dirname(child.sessionPath);
  const lock = await readFile(`${child.sessionPath}.lock`, "utf8");
  const c = h.connect("lifecycle", true);
  assert.deepEqual(await status(c), [], "direct CLI fork owns no children from the source");
  assert.equal((await a.request({ type: "get_state" })).sessionFile, h.file);
  await c.stop();
  const b = h.connect("lifecycle");
  const foreign = (await status(b))[0];
  assert.equal(foreign.external, true);
  assert.equal(foreign.run.state, "running");
  const files = (await readdir(folder)).sort();
  const count = (await records(b)).length;
  for (const args of [{ action: "send", message: "Must not arrive" }, { action: "answer", questionId: "unknown", answer: "No" }, { action: "stop" }]) {
    const result = await invoke(b, { child: "one", ...args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /managed by another window/);
  }
  assert.equal((await records(b)).length, count, "denied commands must append no child state");
  assert.deepEqual((await readdir(folder)).sort(), files, "denied send must not create task-2.md");
  assert.equal(await readFile(`${child.sessionPath}.lock`, "utf8"), lock);
  await tree(b, running.id);
  assert.equal((await status(b))[0].external, true);
  await invoke(b, { action: "launch", agent: "worker", name: "own", task: "B_OWN" });
  await childState(b, (record) => record.name === "own" && record.run.state === "completed");
  await tree(b, running.id);
  assert.equal(await readFile(`${child.sessionPath}.lock`, "utf8"), lock, "B's tree must leave A's writer intact");
  await b.request({ type: "clone" });
  assert.deepEqual(await status(b), []);
  await b.stop();
  assert.equal(await readFile(`${child.sessionPath}.lock`, "utf8"), lock);
  await writeFile(h.gate, "");
  await childState(a, (record) => record.run.state === "completed" && record.run.delivered);
  assert.match(await readFile(join(folder, "result-1.md"), "utf8"), /Batch child full result/);
});

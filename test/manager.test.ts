import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Manager, MAX_ACTIVE_ASSIGNMENTS, type ChildRecord, type ChildSnapshot, type ManagerOptions } from "../src/manager.ts";

async function harness(mode = "hold") {
  const directory = await mkdtemp("/tmp/opencode/sidekicks-manager-");
  const records = new Map<string, ChildRecord>();
  const deliveries: { child: ChildSnapshot; kind: string }[] = [];
  const waiters = new Set<() => void>();
  const options: ManagerOptions = {
    ownerSessionId: "parent", directory, cwd: directory, trusted: false,
    invocation: { command: process.execPath, args: [resolve("test/fixtures/fake-pi.ts")] },
    env: { ...process.env, SIDEKICKS_FAKE_SCENARIO: mode, SIDEKICKS_FAKE_LOG: join(directory, "prompts.jsonl"), SIDEKICKS_DESCENDANT_PID: join(directory, "descendant.pid") },
    persist: (record) => { records.set(record.id, record); },
    deliver: (child, kind) => { deliveries.push({ child, kind }); for (const wake of waiters) wake(); },
    changed: () => { for (const wake of waiters) wake(); },
    dialog: async () => undefined,
  };
  const manager = new Manager(options);
  const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { waiters.delete(wake); reject(new Error("State transition timed out")); }, 5000);
    const wake = () => { if (predicate()) { clearTimeout(timeout); waiters.delete(wake); resolve(); } };
    waiters.add(wake);
    wake();
  });
  const launch = (name = "worker") => manager.launch({ role: name, instructions: "Do the task", name,
    task: "Work", model: "local/scripted", thinking: "off" });
  return { manager, options, directory, records, deliveries, waitFor, launch };
}

test("launch allows more than three assignments, and stop retains the session identity", async (t) => {
  const h = await harness();
  t.after(() => h.manager.shutdown());
  const children = await Promise.all([h.launch("one"), h.launch("two"), h.launch("three"), h.launch("four")]);
  assert(children.every((child) => child.run.state === "running"));
  const stopped = await h.manager.stop(children[0].id);
  assert.equal(stopped.run.state, "cancelled");
  assert.equal(stopped.sessionPath, children[0].sessionPath);
  assert.equal(stopped.connected, false);
  assert.equal(h.deliveries.filter((d) => d.child.id === stopped.id && d.kind === "result").length, 1);
  const next = await h.launch("five");
  assert.equal(next.run.state, "running");
});

test("64 reservations including a waiting assignment fill capacity; cancelled and idle assignments do not", async (t) => {
  const h = await harness("question");
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "waiting");
  const reserveRemaining = () => Array.from({ length: MAX_ACTIVE_ASSIGNMENTS - 1 }, () => assert.rejects(h.manager.launch({
    role: "worker", instructions: "Work", task: "Work", model: "local/scripted", thinking: "off",
  }, AbortSignal.abort()), /abort/i));
  const reservations = reserveRemaining();
  await assert.rejects(h.launch("overflow"), /64 assignments/);
  await Promise.all(reservations);
  await h.manager.answer(child.id, "question-1", "Choose A");
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
  const next = reserveRemaining();
  const extra = assert.rejects(h.manager.launch({ role: "worker", instructions: "Work", task: "Work",
    model: "local/scripted", thinking: "off" }, AbortSignal.abort()), /abort/i);
  await assert.rejects(h.launch("overflow"), /64 assignments/);
  await Promise.all([...next, extra]);
});

test("question delivery is deduplicated; only a matching answer continues the same run", async (t) => {
  const h = await harness("question");
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  await h.waitFor(() => h.deliveries.some((d) => d.kind === "question"));
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.manager.snapshot()[0].run.state, "waiting");
  await assert.rejects(h.manager.send(child.id, "More work"), /pending question/);
  await assert.rejects(h.manager.answer(child.id, "stale", "answer"), /stale/);
  await h.manager.answer(child.id, "question-1", "/must-not-be-a-command");
  await h.waitFor(() => h.deliveries.some((d) => d.kind === "result"));
  const result = h.manager.snapshot()[0];
  assert.equal(result.run.id, child.run.id);
  assert.equal(result.run.state, "completed");
  assert.equal(h.deliveries.length, 2);
  await assert.rejects(h.manager.answer(child.id, "question-1", "duplicate"), /stale/);
  const prompts = (await readFile(join(h.directory, "prompts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(prompts.length, 2);
  assert(prompts.every((p) => !p.message.startsWith("/")));
});

test("cancelling a waiting question delivers cancellation, not a successful result", async (t) => {
  const h = await harness("question");
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  await h.waitFor(() => h.deliveries.length === 1);
  await h.manager.stop(child.id);
  assert.equal(h.deliveries.at(-1)?.child.run.state, "cancelled");
  assert.equal(h.deliveries.length, 2);
});

test("provider failures stay failures, and terminal results arrive once", async (t) => {
  const h = await harness("failure");
  t.after(() => h.manager.shutdown());
  await h.launch();
  await h.waitFor(() => h.deliveries.length === 1);
  assert.equal(h.deliveries[0].child.run.state, "failed");
  assert.match(h.deliveries[0].child.run.result!, /scripted provider failed/);
  await h.manager.stop(h.manager.snapshot()[0].id);
  assert.equal(h.deliveries.length, 1);
});

test("explicit stop wins a race with final result extraction", async (t) => {
  const h = await harness("settling-race");
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  await h.waitFor(() => h.manager.snapshot()[0].activity === "settling");
  await h.manager.stop(child.id);
  assert.equal(h.manager.snapshot()[0].run.state, "cancelled");
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].child.run.state, "cancelled");
});

test("process exit alone is interruption, never successful completion", async (t) => {
  const h = await harness("exit");
  t.after(() => h.manager.shutdown());
  await h.launch();
  await h.waitFor(() => h.deliveries.length === 1);
  assert.equal(h.deliveries[0].child.run.state, "interrupted");
});

test("an unexplained child abort is interruption, not success or explicit cancellation", async (t) => {
  const h = await harness("unexplained-abort");
  t.after(() => h.manager.shutdown());
  await h.launch();
  await h.waitFor(() => h.deliveries.length === 1);
  assert.equal(h.deliveries[0].child.run.state, "interrupted");
});

test("reload invalidates delivery and restores interrupted work without rerunning it", async (t) => {
  const h = await harness();
  const child = await h.launch();
  await h.manager.shutdown();
  assert.equal(h.deliveries.length, 0);
  const restored = new Manager({ ...h.options, restored: [...h.records.values()] });
  t.after(() => restored.shutdown());
  const snapshot = restored.snapshot()[0];
  assert.equal(snapshot.run.state, "interrupted");
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.sessionPath, child.sessionPath);
  const followed = await restored.send(child.id, "Continue explicitly");
  assert.equal(followed.sessionPath, child.sessionPath);
  assert.notEqual(followed.run.id, child.run.id);
  await assert.rejects(h.manager.send(child.id, "old parent"), /no longer active/);
});

test("a second Pi instance cannot become a concurrent writer", async (t) => {
  const h = await harness();
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  const other = new Manager({ ...h.options, restored: [...h.records.values()] });
  t.after(() => other.shutdown());
  await assert.rejects(other.send(child.id, "Do not duplicate"), /session is locked/);
  assert.equal(h.manager.snapshot()[0].run.state, "running");
});

test("invalid model/thinking and malformed RPC fail startup without keeping a live child", async (t) => {
  const h = await harness();
  const invalid = await harness("invalid");
  t.after(() => Promise.all([h.manager.shutdown(), invalid.manager.shutdown()]));
  await assert.rejects(h.manager.launch({ role: "worker", instructions: "work", task: "work", model: "missing/model", thinking: "off" }), /exactly one/);
  await assert.rejects(h.manager.launch({ role: "worker", instructions: "work", task: "work", model: "local/scripted", thinking: "max" }), /unsupported/);
  await assert.rejects(invalid.launch(), /invalid RPC JSON/);
  assert(h.manager.snapshot().every((child) => !child.connected && child.run.state === "failed"));
  assert.equal(invalid.manager.snapshot()[0].run.state, "failed");
});

test("shutdown during readiness cannot leave a writer or submit a task", async () => {
  const h = await harness("slow");
  const launch = h.launch();
  const rejected = assert.rejects(launch, /closed|active/);
  await h.manager.shutdown();
  await rejected;
  assert.equal(h.deliveries.length, 0);
  await assert.rejects(stat(join(h.directory, "prompts.jsonl")), { code: "ENOENT" });
});

test("stop kills tool descendants in the child's process group", async (t) => {
  const h = await harness("descendant");
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  // A following RPC round trip is an ordering barrier after prompt handling.
  await h.manager.send(child.id, "guidance");
  const pid = Number(await readFile(join(h.directory, "descendant.pid"), "utf8"));
  await h.manager.stop(child.id);
  try {
    const state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1][0];
    assert.equal(state, "Z", "descendant must be dead (or awaiting reaping)");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
});

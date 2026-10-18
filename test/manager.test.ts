import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Manager, MAX_ACTIVE_ASSIGNMENTS, type ChildRecord, type ChildSnapshot, type ManagerOptions } from "../src/manager.ts";
import { deliveryText, describeChild } from "../src/present.ts";

async function harness(mode = "hold") {
  const directory = await mkdtemp("/tmp/opencode/sidekicks-manager-");
  const records = new Map<string, ChildRecord>();
  const deliveries: { child: ChildSnapshot; kind: string }[] = [];
  const groups: ChildSnapshot[][] = [];
  const waiters = new Set<() => void>();
  const options: ManagerOptions = {
    ownerSessionId: "parent", directory, cwd: directory, trusted: false,
    invocation: { command: process.execPath, args: [resolve("test/fixtures/fake-pi.ts")] },
    env: { ...process.env, SIDEKICKS_FAKE_SCENARIO: mode, SIDEKICKS_FAKE_LOG: join(directory, "prompts.jsonl"), SIDEKICKS_DESCENDANT_PID: join(directory, "descendant.pid") },
    persist: (record) => { records.set(record.id, record); },
    deliver: (child, kind) => { deliveries.push({ child, kind }); for (const wake of waiters) wake(); },
    deliverGroup: (members) => { groups.push(members); for (const wake of waiters) wake(); },
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
  const launch = (name = "worker") => manager.launch({ agent: name, instructions: "Do the task", name,
    task: "Work", model: "local/scripted", thinking: "off" });
  return { manager, options, directory, records, deliveries, groups, waitFor, launch };
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
    agent: "worker", instructions: "Work", task: "Work", model: "local/scripted", thinking: "off",
  }, AbortSignal.abort()), /abort/i));
  const reservations = reserveRemaining();
  await assert.rejects(h.launch("overflow"), /64 assignments/);
  await Promise.all(reservations);
  await h.manager.answer(child.id, "question-1", "Choose A");
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
  const next = reserveRemaining();
  const extra = assert.rejects(h.manager.launch({ agent: "worker", instructions: "Work", task: "Work",
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
  assert.match(await readFile(h.deliveries[0].child.run.resultFile!, "utf8"), /state: "failed"[\s\S]*scripted provider failed/);
  await h.manager.stop(h.manager.snapshot()[0].id);
  assert.equal(h.deliveries.length, 1);
});

test("each finished run writes its full result beside the transcript, and a follow-up writes another", async (t) => {
  const h = await harness("long-result");
  t.after(() => h.manager.shutdown());
  await h.launch();
  await h.waitFor(() => h.deliveries.length === 1);
  const first = h.deliveries[0].child;
  const file = join(h.directory, `${first.id}.${first.run.id}.result.md`);
  assert.equal(first.run.resultFile, file);
  assert(first.run.result!.endsWith(`[Truncated. Full result: ${file}]`));
  assert(deliveryText(first, "result").includes(`): ${file}\n`));
  const text = await readFile(file, "utf8");
  assert.match(text, /^---\nchild: "worker"\nagent: "worker"\nmodel: "local\/scripted"\nthinking: "off"\nstate: "completed"\nstarted: "\d{4}-[^"]+"\nended: "\d{4}-[^"]+"\ntranscript: "[^"]+\.jsonl"\n---\n\nx{30000}\n$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await h.manager.send("worker", "Continue");
  await h.waitFor(() => h.deliveries.length === 2);
  const second = h.deliveries[1].child;
  assert.notEqual(second.run.id, first.run.id);
  assert.notEqual(second.run.resultFile, file);
  assert.equal((await readFile(file, "utf8")).length, text.length, "the earlier run's file stays as written");
  assert.equal(second.run.endedAt !== undefined && second.run.endedAt >= second.run.startedAt!, true);
});

test("a child runs where it is told, and announces itself as a subagent child", async (t) => {
  const h = await harness("complete");
  t.after(() => h.manager.shutdown());
  const elsewhere = join(h.directory, "elsewhere");
  await mkdir(elsewhere);
  const moved = await h.manager.launch({ agent: "reviewer", instructions: "Do the task", name: "moved", task: "Work", model: "local/scripted", thinking: "off", cwd: elsewhere });
  const home = await h.launch("home");
  await h.waitFor(() => h.deliveries.length === 2);
  assert.equal(moved.cwd, elsewhere);
  assert.equal(home.cwd, undefined, "the parent's own directory is not repeated");
  assert.match(describeChild(moved), /^moved \(reviewer, scripted:off, cwd .*\/elsewhere\) — /);
  const prompts = (await readFile(join(h.directory, "prompts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const at = async (path: string) => realpath(path);
  assert.deepEqual(prompts.map((prompt) => prompt.cwd).sort(), [await at(h.directory), await at(elsewhere)].sort());
  assert(prompts.every((prompt) => prompt.subagentChild === "1"));
  assert.deepEqual(prompts.map((prompt) => prompt.subagentAgent).sort(), ["home", "reviewer"]);
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

test("a lock left by dead processes is replaced; live, unreadable, or half-written locks still refuse", async (t) => {
  const h = await harness();
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  await h.manager.stop(child.id);
  const lock = `${child.sessionPath}.lock`;
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  for (const contents of [JSON.stringify({ pid: process.pid, childPid: dead }), JSON.stringify({ pid: dead, childPid: process.pid }), "", "{not json", JSON.stringify({ token: "no pids" })]) {
    await writeFile(lock, contents);
    await assert.rejects(h.manager.send(child.id, "Blocked"), /locked by a live process/, contents);
  }
  await writeFile(lock, JSON.stringify({ pid: dead, childPid: dead }));
  const resumed = await h.manager.send(child.id, "Resume after crash");
  assert.equal(resumed.run.state, "running");
  assert.equal(resumed.sessionPath, child.sessionPath);
  await h.manager.stop(child.id);
  await writeFile(lock, JSON.stringify({ pid: dead }));
  assert.equal((await h.manager.send(child.id, "Lock written before the child pid existed")).run.state, "running");
});

test("locks from another boot ignore reused live PIDs; same-boot locks fail closed", async (t) => {
  const h = await harness();
  t.after(() => h.manager.shutdown());
  const child = await h.launch();
  const lock = `${child.sessionPath}.lock`;
  const owner = JSON.parse(await readFile(lock, "utf8"));
  assert.equal(owner.bootId, (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
  await h.manager.stop(child.id);
  await writeFile(lock, JSON.stringify({ pid: process.pid, bootId: owner.bootId }));
  await assert.rejects(h.manager.send(child.id, "Same boot"), /locked by a live process/);
  await writeFile(lock, JSON.stringify({ pid: process.pid, childPid: process.pid, bootId: "previous-boot" }));
  assert.equal((await h.manager.send(child.id, "After reboot")).run.state, "running");
});

test("invalid model/thinking and malformed RPC fail startup without keeping a live child", async (t) => {
  const h = await harness();
  const invalid = await harness("invalid");
  t.after(() => Promise.all([h.manager.shutdown(), invalid.manager.shutdown()]));
  await assert.rejects(h.manager.launch({ agent: "worker", instructions: "work", task: "work", model: "missing/model", thinking: "off" }), /exactly one/);
  await assert.rejects(h.manager.launch({ agent: "worker", instructions: "work", task: "work", model: "local/scripted", thinking: "max" }), /unsupported/);
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

test("children get unique handles and are addressable by name", async (t) => {
  const h = await harness();
  t.after(() => h.manager.shutdown());
  const first = await h.manager.launch({ agent: "worker", instructions: "Work", task: "Work", model: "local/scripted", thinking: "off" });
  const second = await h.manager.launch({ agent: "worker", instructions: "Work", task: "Work", model: "local/scripted", thinking: "off" });
  const named = await h.manager.launch({ agent: "worker", instructions: "Work", name: "auditor", task: "Work", model: "local/scripted", thinking: "off" });
  assert.deepEqual([first.name, second.name, named.name], ["worker", "worker-2", "auditor"]);
  await assert.rejects(h.manager.launch({ agent: "worker", instructions: "Work", name: "auditor", task: "Work", model: "local/scripted", thinking: "off" }), /already used/);
  const stopped = await h.manager.stop("worker-2");
  assert.equal(stopped.id, second.id);
  assert.equal(stopped.run.state, "cancelled");
  await assert.rejects(h.manager.stop("nobody"), /Unknown child: nobody. Known: worker, worker-2, auditor/);
});

const assignment = (name: string, outcome = "hold") => ({ agent: "worker", instructions: "Work", name,
  task: `outcome=${outcome}`, model: "local/scripted", thinking: "off" as const });

for (const results of ["together", "each"] as const) {
  test(`batch ${results} delivers completed outcomes exactly once`, async (t) => {
    const h = await harness("batch");
    t.after(() => h.manager.shutdown());
    await h.manager.launchBatch([assignment("one", "complete"), assignment("two", "complete")], results);
    await h.waitFor(() => h.manager.snapshot().every((child) => child.run.delivered));
    assert.equal(h.deliveries.length, results === "each" ? 2 : 0);
    assert.equal(h.groups.length, results === "together" ? 1 : 0);
    if (results === "together") assert.deepEqual(h.groups[0].map((child) => child.name).sort(), ["one", "two"]);
    h.manager.releaseHeld();
    assert.equal(h.groups.length, results === "together" ? 1 : 0);
  });
}

test("a batch failure is immediate; siblings keep running and later share completed results", async (t) => {
  const h = await harness("batch");
  t.after(() => h.manager.shutdown());
  await h.manager.launchBatch([assignment("bad", "failure"), assignment("slow"), assignment("done", "complete")]);
  await h.waitFor(() => h.deliveries.length === 1 && h.manager.snapshot().find((child) => child.name === "done")?.run.state === "completed");
  assert.equal(h.deliveries[0].child.run.state, "failed");
  assert.equal(h.manager.snapshot().find((child) => child.name === "slow")?.run.state, "running");
  assert.equal(h.groups.length, 0);
  await h.manager.send("slow", "outcome=complete");
  await h.waitFor(() => h.groups.length === 1);
  assert.equal(h.deliveries.length, 1);
  assert.deepEqual(h.groups[0].map((child) => [child.name, child.run.state, child.run.delivered]).sort(),
    [["bad", "failed", true], ["done", "completed", false], ["slow", "completed", false]]);
});

for (const held of [false, true]) {
  test(`stopping remaining grouped members ${held ? "releases held results" : "has no delivery"}`, async (t) => {
    const h = await harness("batch");
    t.after(() => h.manager.shutdown());
    await h.manager.launchBatch([assignment("one", held ? "complete" : "hold"), assignment("two")]);
    if (held) await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
    else await h.manager.stop("one");
    await h.manager.stop("two");
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.groups.length, held ? 1 : 0);
    assert(h.manager.snapshot().every((child) => child.run.delivered));
  });
}

test("grouped questions remain immediate and waiting members hold the group open", async (t) => {
  const h = await harness("question");
  t.after(() => h.manager.shutdown());
  await h.manager.launchBatch([assignment("one"), assignment("two")]);
  await h.waitFor(() => h.deliveries.length === 2);
  assert(h.deliveries.every((delivery) => delivery.kind === "question"));
  await h.manager.answer("one", "question-1", "A");
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
  assert.equal(h.manager.snapshot()[1].run.state, "waiting");
  assert.equal(h.groups.length, 0);
  await h.manager.answer("two", "question-1", "B");
  await h.waitFor(() => h.groups.length === 1);
  assert.equal(h.deliveries.length, 2);
});

test("grouped process loss is reported immediately without stopping siblings", async (t) => {
  const h = await harness("batch");
  t.after(() => h.manager.shutdown());
  await h.manager.launchBatch([assignment("lost", "exit"), assignment("other")]);
  await h.waitFor(() => h.deliveries.length === 1);
  assert.equal(h.deliveries[0].child.run.state, "interrupted");
  assert.equal(h.manager.snapshot()[1].run.state, "running");
  await h.manager.send("other", "outcome=complete");
  await h.waitFor(() => h.groups.length === 1);
  assert.equal(h.deliveries.length, 1);
});

test("send releases an individual held result and leaves its group", async (t) => {
  const h = await harness("batch");
  t.after(() => h.manager.shutdown());
  await h.manager.launchBatch([assignment("one", "complete"), assignment("two")]);
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
  const before = h.manager.snapshot()[0];
  await h.manager.send("one", "outcome=hold");
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].child.run.id, before.run.id);
  assert.equal(h.deliveries[0].child.run.state, "completed");
  assert.equal(h.manager.snapshot()[0].run.groupId, undefined);
  await h.manager.stop("two");
  assert.equal(h.groups.length, 0);
});

test("restore releases held completed results once after runtime activation, without replay", async (t) => {
  const h = await harness("batch");
  await h.manager.launchBatch([assignment("one", "complete"), assignment("two")]);
  await h.waitFor(() => h.manager.snapshot()[0].run.state === "completed");
  const saved = [...h.records.values()];
  await h.manager.shutdown();
  const restored = new Manager({ ...h.options, restored: saved });
  t.after(() => restored.shutdown());
  assert.equal(h.groups.length, 0);
  restored.releaseHeld();
  restored.releaseHeld();
  assert.equal(h.groups.length, 1);
  assert.deepEqual(h.groups[0].map((child) => child.run.state), ["completed", "interrupted"]);
  assert(restored.snapshot().every((child) => child.run.delivered));
  const again = new Manager({ ...h.options, restored: [...h.records.values()] });
  t.after(() => again.shutdown());
  again.releaseHeld();
  assert.equal(h.groups.length, 1);
  assert.equal(h.deliveries.length, 0);
});

test("batch name and capacity validation starts nothing; startup errors remain per-member", async (t) => {
  const h = await harness("batch");
  t.after(() => h.manager.shutdown());
  await assert.rejects(h.manager.launchBatch([assignment("same"), assignment("same")]), /already used/);
  await assert.rejects(h.manager.launchBatch(Array.from({ length: 65 }, (_, i) => assignment(`child-${i}`))), /64 assignments/);
  assert.equal(h.manager.snapshot().length, 0);
  await assert.rejects(stat(join(h.directory, "prompts.jsonl")), { code: "ENOENT" });
  const outcomes = await h.manager.launchBatch([assignment("good", "complete"), { ...assignment("bad"), model: "missing/model" }]);
  assert.equal(outcomes[0].error, undefined);
  assert.match(outcomes[1].error!, /exactly one/);
  await h.waitFor(() => h.groups.length === 1);
  assert.deepEqual(h.groups[0].map((child) => child.name), ["good"]);
  assert.equal(h.deliveries.length, 0);
  await assert.rejects(h.manager.launchBatch([assignment("good"), assignment("new")]), /already used/);
  assert.equal(h.manager.snapshot().length, 2);
  await h.manager.launch(assignment("existing"));
  const before = h.manager.snapshot();
  await assert.rejects(h.manager.launchBatch(Array.from({ length: 64 }, (_, i) => assignment(`extra-${i}`))), /64 assignments/);
  assert.deepEqual(h.manager.snapshot(), before, "existing active assignments count against the whole batch reservation");
});

for (const mode of ["hold", "exit", "complete", "failure"]) {
  test(`follow-up hint after ${mode} reflects partial-work risk only when interrupted/stopped`, async (t) => {
    const h = await harness(mode);
    t.after(() => h.manager.shutdown());
    const child = await h.launch();
    if (mode === "hold") await h.manager.stop(child.id);
    else await h.waitFor(() => h.deliveries.length === 1);
    if (mode === "exit") await h.waitFor(() => h.manager.snapshot()[0].activity === "detached");
    await h.manager.send(child.id, "Next assignment");
    const prompts = (await readFile(join(h.directory, "prompts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const follow = prompts.at(-1).message;
    if (mode === "hold" || mode === "exit") {
      assert.match(follow, /^Sidekicks follow-up:\nYour previous run was (stopped|interrupted)\./);
      assert.match(follow, /partial changes.*Check the current state before repeating anything\./);
    } else assert.equal(follow, "Sidekicks follow-up:\nNext assignment");
  });
}

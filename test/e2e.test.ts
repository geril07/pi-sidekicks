import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RpcConnection, type RpcEvent } from "../src/rpc.ts";
import { Manager, type ChildRecord, type ChildSnapshot } from "../src/manager.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const batchTask = (name: string) => ({ agent: "worker", task: "Return local evidence", name });
for (const scenario of [
  { label: "together", launch: { tasks: [batchTask("one"), batchTask("two")] }, deliveries: 1 },
  { label: "shared", launch: { tasks: [{ ...batchTask("one"), task: "Review runtime" }, { ...batchTask("two"), task: "Review tests" }], shared: "Common instructions" }, deliveries: 1 },
  { label: "blank shared", launch: { tasks: [batchTask("one"), batchTask("two")], shared: " \n\t" }, deliveries: 1 },
  { label: "shared without tasks", launch: { agent: "worker", task: "Work", shared: "Common instructions" }, error: /launch without tasks does not take: shared/ },
  { label: "empty own task with shared", launch: { tasks: [batchTask("one"), { ...batchTask("two"), task: " \n\t" }], shared: "Common instructions" }, error: /agent and task must not be blank/ },
  { label: "each", launch: { tasks: [batchTask("one"), batchTask("two")], results: "each" }, deliveries: 2 },
  { label: "unknown agent", launch: { tasks: [batchTask("one"), { ...batchTask("two"), agent: "missing" }] }, error: /Unknown agent/ },
  { label: "duplicate name", launch: { tasks: [batchTask("one"), batchTask("one")] }, error: /Name already used/ },
  { label: "capacity", launch: { tasks: Array.from({ length: 65 }, (_, i) => batchTask(`child-${i}`)) }, error: /64 assignments/ },
  { label: "mixed fields", launch: { tasks: [batchTask("one")], agent: "worker" }, error: /does not take: agent/ },
  { label: "results without tasks", launch: { agent: "worker", task: "Work", results: "each" }, error: /does not take: results/ },
]) {
  test(`real subagent batch API: ${scenario.label}`, { timeout: 30_000 }, async (t) => {
    const h = await isolated("batch-parent");
    const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
      "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
      { cwd: h.dir, env: { ...h.env, SIDEKICKS_TEST_LAUNCH: JSON.stringify(scenario.launch) } });
    t.after(() => rpc.stop());
    await rpc.request({ type: "prompt", message: "Launch the requested batch." });
    const deadline = performance.now() + 15_000;
    let entries = (await rpc.request({ type: "get_entries" })).entries;
    while (true) {
      const notifications = entries.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"));
      const results = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent");
      if (scenario.error ? results.length > 0 : notifications.length === scenario.deliveries) break;
      assert(performance.now() < deadline, "Batch tool or delivery timed out");
      await delay(20);
      entries = (await rpc.request({ type: "get_entries" })).entries;
    }
    const records = entries.filter((entry) => entry.type === "custom" && entry.customType === "sidekicks:state");
    const notifications = entries.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"));
    const toolResult = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent");
    assert(toolResult?.type === "message" && toolResult.message.role === "toolResult");
    if (scenario.error) {
      assert.equal(toolResult.message.isError, true);
      assert.match(JSON.stringify(toolResult.message.content), scenario.error);
      assert.equal(records.length, 0, "whole-batch rejection must reserve/start nothing");
      const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert(calls.every((call) => call.child === "parent"));
    } else {
      assert.equal(toolResult.message.isError, false);
      if (scenario.label === "shared" || scenario.label === "blank shared") {
        const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const prompts = calls.filter((call) => call.child !== "parent").map((call) => call.lastUser);
        const prefix = scenario.label === "shared" ? "Common instructions\n\n" : "";
        assert.equal(prompts.length, 2);
        for (const task of scenario.launch.tasks!) {
          assert(prompts.some((prompt) => JSON.stringify(prompt).includes(JSON.stringify(`Task:\n${prefix}${task.task}`).slice(1, -1))));
        }
      }
      assert.match(JSON.stringify(toolResult.message.content), /one.*two/s);
      assert.equal(notifications.length, scenario.deliveries);
      assert(notifications.every((entry) => entry.type === "custom_message" && entry.customType === `sidekicks:${scenario.label === "each" ? "result" : "group"}`));
      if (scenario.label === "together") {
        assert(notifications[0].type === "custom_message");
        assert.match(String(notifications[0].content), /batch of 2 · 2 completed/);
        assert.equal((String(notifications[0].content).match(/Batch child full result/g) ?? []).length, 2);
      }
    }
    await rpc.request({ type: "new_session" });
  });
}

const placed = (extra: object) => ({ agent: "worker", task: "Work", name: "one", ...extra });
for (const scenario of [
  { label: "a :thinking suffix on model sets thinking", launch: () => placed({ model: "sidekicks-test/scripted:high" }), child: { model: "sidekicks-test/scripted", thinking: "high" } },
  { label: "the same level in both places is accepted", launch: () => placed({ model: "sidekicks-test/scripted:high", thinking: "high" }), child: { model: "sidekicks-test/scripted", thinking: "high" } },
  { label: "a conflicting suffix and thinking is rejected", launch: () => placed({ model: "sidekicks-test/scripted:high", thinking: "low" }), error: /suffix :high conflicts with thinking low/ },
  { label: "a relative cwd resolves against the parent", launch: () => placed({ cwd: "sub" }), subdir: "sub" },
  { label: "a missing cwd is rejected before anything starts", launch: () => placed({ cwd: "missing" }), error: /cwd must be an existing directory/ },
  { label: "one missing cwd rejects the whole batch", launch: () => ({ tasks: [placed({}), placed({ name: "two", cwd: "missing" })] }), error: /cwd must be an existing directory/ },
]) {
  test(`real launch: ${scenario.label}`, { timeout: 30_000 }, async (t) => {
    const h = await isolated("batch-parent");
    await mkdir(join(h.dir, "sub"));
    const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
      "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
      { cwd: h.dir, env: { ...h.env, SIDEKICKS_TEST_LAUNCH: JSON.stringify(scenario.launch()) } });
    t.after(() => rpc.stop());
    await rpc.request({ type: "prompt", message: "Launch the requested child." });
    const deadline = performance.now() + 15_000;
    let entries = (await rpc.request({ type: "get_entries" })).entries;
    while (!entries.some((entry) => scenario.error ? entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent"
      : entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"))) {
      assert(performance.now() < deadline, "Launch or delivery timed out");
      await delay(20);
      entries = (await rpc.request({ type: "get_entries" })).entries;
    }
    const records = entries.filter((entry) => entry.type === "custom" && entry.customType === "sidekicks:state");
    const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    if (scenario.error) {
      const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent");
      assert(result?.type === "message" && result.message.role === "toolResult" && result.message.isError);
      assert.match(JSON.stringify(result.message.content), scenario.error);
      assert.equal(records.length, 0, "a rejected launch must reserve and start nothing");
      assert(calls.every((call) => call.child === "parent"));
      return;
    }
    const last = records.at(-1);
    assert(last?.type === "custom");
    const child = last.data as ChildRecord;
    if (scenario.child) assert.deepEqual({ model: child.model, thinking: child.thinking }, scenario.child);
    if (scenario.subdir) {
      assert.equal(child.cwd, join(h.dir, scenario.subdir));
      assert.equal(calls.find((call) => call.child !== "parent")?.cwd, await realpath(join(h.dir, scenario.subdir)));
    }
  });
}

test("herdr:busy stays raised while a child runs after the parent turn ends and drops once the result wake has started", { timeout: 30_000 }, async (t) => {
  const h = await isolated("batch-parent");
  const gate = join(h.dir, "release-child");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
    { cwd: h.dir, env: { ...h.env, SIDEKICKS_TEST_GATE: gate,
      SIDEKICKS_TEST_LAUNCH: JSON.stringify({ agent: "worker", task: "Return local evidence", name: "one" }) } });
  t.after(() => rpc.stop());
  const sequence = async () => (await readFile(`${h.log}.events`, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const waitFor = async (predicate: (sequence: string[]) => boolean) => {
    const deadline = performance.now() + 15_000;
    while (!predicate(await sequence())) {
      assert(performance.now() < deadline, "Expected herdr event sequence timed out");
      await delay(20);
    }
  };
  await rpc.request({ type: "prompt", message: "Launch one child." });
  await waitFor((events) => events.includes("busy:true") && events.includes("agent_settled"));
  await delay(200);
  assert(!(await sequence()).includes("busy:false"), "a running child must keep the pane busy after the parent settles");
  await writeFile(gate, "");
  await waitFor((events) => events.includes("busy:false"));
  const events = await sequence();
  assert.deepEqual(events.filter((event) => event.startsWith("busy:")), ["busy:true", "busy:false"]);
  const wake = events.indexOf("agent_start", events.indexOf("agent_settled"));
  assert(wake > 0 && events.indexOf("busy:false") > wake, `busy must drop after the wake turn starts: ${events.join(",")}`);
});

test("a result reaches a parent that is still calling tools, instead of waiting for its run to end", { timeout: 30_000 }, async (t) => {
  const h = await isolated("busy-parent");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(h.dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] }, { cwd: h.dir, env: h.env });
  t.after(() => rpc.stop());
  await rpc.request({ type: "prompt", message: "Launch one child and keep working." });
  const deadline = performance.now() + 20_000;
  while ((await rpc.request({ type: "get_state" })).isStreaming) {
    assert(performance.now() < deadline, "Parent run did not finish");
    await delay(50);
  }
  const text = JSON.stringify((await rpc.request({ type: "get_entries" })).entries);
  assert.match(text, /FINAL: result arrived while busy\./);
  assert.doesNotMatch(text, /GAVE UP/);
});

async function isolated(scenario: string) {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-e2e-");
  const agent = join(dir, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(agent, "sidekicks"));
  await symlink(resolve("test/fixtures/faux-provider.ts"), join(agent, "extensions", "faux-provider.ts"));
  await writeFile(join(agent, "sidekicks", "worker.md"), "---\nname: worker\ndescription: Test worker\n---\nComplete the delegated task.\n");
  const log = join(dir, "calls.jsonl");
  return { dir, agent, log, env: { ...process.env, PI_CODING_AGENT_DIR: agent,
    SIDEKICKS_TEST_LOG: log, SIDEKICKS_TEST_SCENARIO: scenario } };
}

test("real send tool switches provider/model/thinking after quota failure and retains the conversation across reload", { timeout: 60_000 }, async (t) => {
  const h = await isolated("model-switch");
  const parentSession = join(h.dir, "parent.jsonl");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", parentSession, "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] }, { cwd: h.dir, env: h.env });
  t.after(() => rpc.stop());
  await rpc.request({ type: "set_auto_retry", enabled: false });
  const entries = async () => (await rpc.request({ type: "get_entries" })).entries;
  const toolResults = (all: Awaited<ReturnType<typeof entries>>) => all.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent");
  const waitFor = async <T,>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
    const deadline = performance.now() + 15_000;
    while (true) {
      const value = await read();
      if (ready(value)) return value;
      assert(performance.now() < deadline, "Model continuation timed out");
      await delay(10);
    }
  };
  const idle = () => waitFor(() => rpc.request({ type: "get_state" }), (state) => !state.isStreaming && !state.pendingMessageCount);
  const invoke = async (args: object) => {
    await idle();
    const before = toolResults(await entries()).length;
    await rpc.request({ type: "prompt", message: `MODEL_CALL ${JSON.stringify(args)}` });
    const all = await waitFor(entries, (all) => toolResults(all).length > before);
    const result = toolResults(all).at(-1)!;
    assert(result.type === "message" && result.message.role === "toolResult");
    return result.message;
  };
  const lastChild = async () => {
    const entry = (await entries()).filter((entry) => entry.type === "custom" && entry.customType === "sidekicks:state").at(-1);
    assert(entry?.type === "custom");
    return entry.data as ChildRecord;
  };
  const settled = (state: string) => waitFor(lastChild, (child) => child.run.state === state);
  const launch = await invoke({ action: "launch", agent: "worker", name: "target", task: "Remember CODEWORD", model: "sidekicks-test/scripted:low" });
  assert.equal(launch.isError, false);
  const first = await settled("completed");
  const header = (await readFile(first.sessionPath, "utf8")).split("\n")[0];
  for (const args of [
    { action: "send", child: "target", message: "Invalid model", model: "missing/model" },
    { action: "send", child: "target", message: "No separate thinking", thinking: "high" },
    { action: "answer", child: "target", questionId: "stale", answer: "A", model: "sidekicks-next/alternate" },
  ]) {
    assert.equal((await invoke(args)).isError, true);
    assert.equal((await lastChild()).run.id, first.run.id);
    assert.equal((await lastChild()).model, first.model);
  }
  assert.equal((await invoke({ action: "send", child: "target", message: "FAIL_QUOTA" })).isError, false);
  const failed = await settled("failed");
  assert.match(failed.run.result!, /Synthetic quota exhausted/);
  const changed = await invoke({ action: "send", child: "target", message: "Continue the saved work", model: "sidekicks-next/alternate:high" });
  assert.equal(changed.isError, false);
  assert.match(JSON.stringify(changed.content), /Model: sidekicks-next\/alternate:high/);
  const next = await settled("completed");
  assert.equal(next.id, first.id);
  assert.equal(next.name, first.name);
  assert.equal(next.agent, first.agent);
  assert.equal(next.instructions, first.instructions);
  assert.equal(next.cwd, first.cwd);
  assert.equal(next.sessionPath, first.sessionPath);
  assert.equal(next.model, "sidekicks-next/alternate");
  assert.equal(next.thinking, "high");
  assert.equal(next.run.number, 3);
  const transcript = (await readFile(first.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert(transcript.some((entry) => entry.type === "model_change" && entry.provider === "sidekicks-next" && entry.modelId === "alternate"));
  assert(transcript.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));
  assert(transcript.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.provider === "sidekicks-next"));
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const continued = calls.filter((call) => call.child === first.id).at(-1);
  assert.match(continued.transcript, /Remember CODEWORD/);
  assert.equal(calls.filter((call) => call.child === first.id).length, 3, "invalid overrides never call a child provider");
  await idle();
  await rpc.request({ type: "prompt", message: "/qa-reload" });
  assert.equal((await invoke({ action: "send", child: "target", message: "Continue after reload" })).isError, false);
  const reopened = await settled("completed");
  assert.equal(reopened.model, "sidekicks-next/alternate");
  assert.equal(reopened.thinking, "high");
  assert.equal(reopened.run.number, 4);
  assert.equal((await readFile(first.sessionPath, "utf8")).split("\n")[0], header);
});

for (const stopEarly of [false, true]) {
test(`nonblocking questions notify during work, accept active and late replies, and cancel on stop (early: ${stopEarly})`, { timeout: 30_000 }, async (t) => {
  const h = await isolated("nonblocking");
  const gate = join(h.dir, "release-effect");
  const deliveries: { child: ChildSnapshot; kind: string; questionId?: string }[] = [];
  const manager = new Manager({ ownerSessionId: "real-parent", parentSessionFile: () => join(h.dir, "parent.jsonl"), cwd: h.dir, trusted: false,
    invocation: { command: process.execPath, args: [cli] },
    env: { ...h.env, SIDEKICKS_TEST_GATE: gate, SIDEKICKS_TEST_BATCH: '["ask_parent","effect","ask_parent","ask_parent"]' },
    persist() {}, changed() {}, dialog: async () => undefined,
    deliver: (child, kind, question) => { deliveries.push({ child, kind, questionId: question?.id }); },
  });
  t.after(() => manager.shutdown());
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      assert(performance.now() < deadline, "State transition timed out");
      await delay(10);
    }
  };
  const calls = async () => (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const child = await manager.launch({ agent: "worker", instructions: "Work", task: "Ask and continue", model: "sidekicks-test/scripted", thinking: "low" });
  await waitFor(() => deliveries.length === 3);
  assert(deliveries.every((d) => d.kind === "question" && d.child.run.state === "running"));
  const questions = manager.snapshot()[0].questions!;
  assert.equal(questions.length, 3);
  assert.equal(new Set(questions.map((q) => q.id)).size, 3);
  assert(questions.every((q) => q.runId === child.run.id));
  assert.equal((await calls()).filter((r) => r.call).length, 1);
  if (stopEarly) {
    await manager.stop(child.id);
    const stopped = manager.snapshot()[0];
    assert.equal(stopped.run.state, "cancelled");
    assert.equal(stopped.connected, false);
    assert.equal(stopped.questions!.length, 0);
    assert.equal(deliveries.filter((d) => d.kind === "result").length, 0, "a stop is reported by its tool result only");
    await assert.rejects(manager.answer(child.id, questions[0].id, "after stop"), /stale/);
    assert.equal((await calls()).filter((r) => r.call).length, 1);
    return;
  }
  await manager.answer(child.id, questions[0].id, "/active answer: A");
  await assert.rejects(manager.answer(child.id, questions[0].id, "duplicate"), /stale/);
  await manager.send(child.id, "Ordinary guidance is allowed while questions are outstanding");
  assert.equal(manager.snapshot()[0].run.state, "running");
  await writeFile(gate, "release");
  await waitFor(() => deliveries.some((d) => d.kind === "result"));
  const result = manager.snapshot()[0].run;
  assert.equal(result.state, "completed");
  assert.equal(result.id, child.run.id);
  const afterActive = await calls();
  assert.match(afterActive.at(-1).transcript, /active answer: A/);
  assert.match(afterActive.at(-1).transcript, new RegExp(questions[0].id));
  // Auto-close released the finished process; a late answer is new work, so it revives the conversation.
  await waitFor(() => manager.snapshot()[0].connected === false);
  assert.equal(manager.snapshot()[0].questions!.length, 2);
  await manager.answer(child.id, questions[1].id, "late answer: B");
  await assert.rejects(manager.answer(child.id, questions[1].id, "duplicate"), /stale/);
  assert.equal(manager.snapshot()[0].questions!.length, 1);
  await waitFor(() => deliveries.filter((d) => d.kind === "result").length === 2);
  const late = manager.snapshot()[0].run;
  assert.equal(late.state, "completed");
  assert.notEqual(late.id, result.id);
  assert.equal(late.number, 2);
  assert.match((await calls()).at(-1).transcript, /late answer: B/);
  assert.match(await readFile(child.sessionPath, "utf8"), /late answer: B/);
  await manager.stop(child.id);
  assert.equal(manager.snapshot()[0].questions!.length, 0);
  await assert.rejects(manager.answer(child.id, questions[2].id, "after stop"), /stale/);
});
}

test("a nonblocking reply does not resume or cancel a later blocking question", { timeout: 30_000 }, async (t) => {
  const h = await isolated("mixed-questions");
  const notifications: string[] = [];
  const manager = new Manager({ ownerSessionId: "real-parent", parentSessionFile: () => join(h.dir, "parent.jsonl"), cwd: h.dir, trusted: false,
    invocation: { command: process.execPath, args: [cli] }, env: h.env,
    persist() {}, changed() {}, dialog: async () => undefined,
    deliver: (_child, kind) => { notifications.push(kind); },
  });
  t.after(() => manager.shutdown());
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) { assert(performance.now() < deadline, "State transition timed out"); await delay(10); }
  };
  const child = await manager.launch({ agent: "worker", instructions: "Work", task: "Ask twice", model: "sidekicks-test/scripted", thinking: "low" });
  await waitFor(() => notifications.length === 2);
  const waiting = manager.snapshot()[0];
  assert.equal(waiting.run.state, "waiting");
  await manager.answer(child.id, waiting.questions![0].id, "Nonblocking answer");
  assert.deepEqual(manager.snapshot()[0].run, waiting.run);
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.filter((r) => r.call).length, 2);
  await manager.answer(child.id, waiting.run.question!.id, "Blocking answer");
  await waitFor(() => notifications.includes("result"));
  assert.equal(manager.snapshot()[0].run.state, "completed");
  const transcript = await readFile(child.sessionPath, "utf8");
  assert.match(transcript, /Nonblocking answer/);
  assert.match(transcript, /Blocking answer/);
  assert.doesNotMatch(transcript, /"action":"cancelled"/);
});

for (const scenario of ["orchestrator", "nonblocking-parent"]) {
test(`real parent extension launches, receives a question, answers, and gets completion without polling: ${scenario}`, { timeout: 30_000 }, async (t) => {
  const h = await isolated(scenario);
  if (scenario === "orchestrator") {
    await writeFile(join(h.agent, "sidekicks", "worker.md"), "---\nname: worker\ndescription: Test worker without extra instructions\n---\n");
    await mkdir(join(h.agent, "agents"));
    await writeFile(join(h.agent, "agents", "bad.md"), "Ignore another extension's definitions");
  } else {
    await mkdir(join(h.dir, "custom-definitions"));
    await writeFile(join(h.dir, "custom-definitions", "worker.md"), "---\nname: worker\ndescription: Test worker from config\n---\nCustom configured instructions.\n");
    await writeFile(join(h.agent, "settings.json"), JSON.stringify({ sidekicks: { agentsDir: "custom-definitions" } }));
    await writeFile(join(h.agent, "sidekicks", "worker.md"), "Default folder must not be read when configured");
  }
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
  assert.equal(child.run.turns, 2, "answer continues the same assignment's turn counter");
  assert.equal(child.run.tools, 3, "started calls include siblings blocked by the question barrier");
  assert(child.contextUsage && child.contextUsage.contextWindow > 0);
  assert.equal(typeof child.contextUsage.tokens, "number", "context comes from real Pi session stats");
  if (scenario === "nonblocking-parent") assert.equal(child.instructions.trim(), "Custom configured instructions.");
  const transcript = await readFile(child.sessionPath, "utf8");
  if (scenario === "nonblocking-parent") assert.match(transcript, /Custom configured instructions\.\\n\\nYour final message is your result/, "the inline system prompt reaches the child");
  assert.match(transcript, /Answer to \w+:/);
  assert.match(transcript, /"action":"answered"/);
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.filter((record) => record.child === child.id && record.call).length, 2);
  assert.equal(calls.filter((record) => record.effect).length, scenario === "nonblocking-parent" ? 2 : 0);
  await rpc.request({ type: "prompt", message: "/qa-reload" });
  assert.equal((await rpc.request({ type: "get_state" })).isStreaming, false);
  const afterReload = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(afterReload.filter((record) => record.call).length, calls.filter((record) => record.call).length,
    "reload must not replay assignments or notifications");
  await rpc.request({ type: "new_session" });
});
}

test("real child reopens its persisted conversation, loading ambient extensions again", { timeout: 30_000 }, async (t) => {
  const h = await isolated("reopen");
  const deliveries: ChildSnapshot[] = [];
  let resolveDelivery: (() => void) | undefined;
  const manager = new Manager({ ownerSessionId: "real-parent", parentSessionFile: () => join(h.dir, "parent.jsonl"), cwd: h.dir, trusted: false,
    invocation: { command: process.execPath, args: [cli] }, env: h.env,
    persist() {}, changed() {}, dialog: async () => undefined,
    deliver: (child) => { deliveries.push(child); resolveDelivery?.(); },
  });
  t.after(() => manager.shutdown());
  const nextDelivery = () => new Promise<void>((resolve) => { resolveDelivery = resolve; });
  let delivered = nextDelivery();
  const child = await manager.launch({ agent: "worker", instructions: "Work", task: "Ask", model: "sidekicks-test/scripted", thinking: "low" });
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
  assert(!warnings.some((warning) => warning.includes("QA child toast")), "a child's notifications do not reach the parent");
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const result = calls.find((call) => call.dialogs)?.dialogs;
  assert.deepEqual(result, { confirmed: false, selected: "B", input: "qa-value" });
  await rpc.request({ type: "new_session" });
});

async function parentWith(t: test.TestContext, h: Awaited<ReturnType<typeof isolated>>, launch: object, session: string) {
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(h.dir, session), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
    { cwd: h.dir, env: { ...h.env, SIDEKICKS_TEST_LAUNCH: JSON.stringify(launch) } });
  t.after(() => rpc.stop());
  const notices: { message: string; level?: string }[] = [];
  rpc.on("event", (event: RpcEvent) => {
    if (event.type === "extension_ui_request" && event.method === "notify") notices.push({ message: event.message, level: event.notifyType });
  });
  const toolResult = async () => {
    await rpc.request({ type: "prompt", message: "Launch the requested agent." });
    const deadline = performance.now() + 15_000;
    while (true) {
      const entries = (await rpc.request({ type: "get_entries" })).entries;
      const found = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent");
      if (found?.type === "message" && found.message.role === "toolResult") return found.message;
      assert(performance.now() < deadline, "Launch tool result timed out");
      await delay(20);
    }
  };
  return { rpc, notices, toolResult };
}

test("an invalid agent definition is skipped with one notice to the user, and the valid agents still launch", { timeout: 30_000 }, async (t) => {
  const h = await isolated("batch-parent");
  await writeFile(join(h.agent, "sidekicks", "broken.md"), "---\nname: broken\n---\n");
  const parent = await parentWith(t, h, { agent: "worker", task: "Return local evidence" }, "parent.jsonl");
  const result = await parent.toolResult();
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /worker/);
  const own = parent.notices.filter((notice) => notice.message.startsWith("sidekicks:"));
  assert.equal(own.length, 1, "the user is told once, at session start");
  assert.equal(own[0].level, "warning");
  assert.match(own[0].message, /skipped 1 invalid agent definition\./);
  assert.match(own[0].message, /broken\.md: needs a name and a description/);
  const calls = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert(!calls.some((call) => JSON.stringify(call).includes("broken")), "the agent never hears about the broken file");
});

test("agent definitions are read when the session starts, not on every model turn", { timeout: 60_000 }, async (t) => {
  const h = await isolated("batch-parent");
  await writeFile(join(h.agent, "sidekicks", "broken.md"), "---\nname: broken\n---\n");
  const first = await parentWith(t, h, { agent: "late", task: "Return local evidence" }, "first.jsonl");
  while (first.notices.length === 0) await delay(20);
  await writeFile(join(h.agent, "sidekicks", "late.md"), "---\nname: late\ndescription: Added after the session started\n---\n");
  const stale = await first.toolResult();
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /Unknown agent\. Available: worker/);
  const second = await parentWith(t, h, { agent: "late", task: "Return local evidence" }, "second.jsonl");
  assert.equal((await second.toolResult()).isError, false, "a new session start sees the file");
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RpcConnection } from "../src/rpc.ts";
import type { ChildRecord } from "../src/manager.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

async function harness(t: test.TestContext, mode: "on" | "only") {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-notification-api-");
  const agent = join(dir, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(agent, "sidekicks"));
  await symlink(resolve("test/fixtures/faux-provider.ts"), join(agent, "extensions/faux-provider.ts"));
  await writeFile(join(agent, "sidekicks/worker.md"), "---\nname: worker\ndescription: API_TEST_WORKER_DESCRIPTION\n---\nDo the task.\n");
  await writeFile(join(agent, "settings.json"), JSON.stringify({ codemode: { mode, inlineBudget: 12000 }, checkForUpdates: false }));
  const gate = join(dir, "release");
  const log = join(dir, "calls.jsonl");
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve", "--tools", "+codemode",
    "--session", join(dir, "parent.jsonl"), "-e", resolve("src/index.ts"), "--model", "sidekicks-test/scripted"] },
  { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agent, SIDEKICKS_TEST_SCENARIO: "api-parent", SIDEKICKS_TEST_LOG: log, SIDEKICKS_TEST_GATE: gate } });
  t.after(() => rpc.stop());
  const entries = async () => (await rpc.request({ type: "get_entries" })).entries;
  const results = async () => (await entries()).flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
  const records = async () => {
    const latest = new Map<string, ChildRecord>();
    for (const entry of await entries()) if (entry.type === "custom" && entry.customType === "sidekicks:state") {
      const child = entry.data as ChildRecord;
      latest.set(child.name, child);
    }
    return latest;
  };
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = performance.now() + 20000;
    while (!await predicate()) {
      assert(performance.now() < deadline, `API transition timed out; evidence: ${dir}`);
      await delay(20);
    }
  };
  const idle = () => waitFor(async () => !(await rpc.request({ type: "get_state" })).isStreaming);
  const invoke = async (prompt: string) => {
    await idle();
    const before = (await results()).length;
    await rpc.request({ type: "prompt", message: prompt });
    await waitFor(async () => (await results()).length > before);
    await idle();
    return (await results()).at(-1)!;
  };
  const code = (source: string) => invoke(`CODE_CALL ${source}`);
  const call = (tool: string, args: object) => invoke(`API_CALL ${JSON.stringify({ tool, args })}`);
  const notifications = async () => (await entries()).filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"));
  return { dir, agent, rpc, entries, records, results, waitFor, idle, code, call, notifications,
    release: (name: string) => writeFile(`${gate}-${name}`, ""),
    calls: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

for (const mode of ["on", "only"] as const) {
  test(`real codemode ${mode}: launch startup, raw errors, grouped notification, and ordinary delivery`, { timeout: 60000 }, async (t) => {
    const h = await harness(t, mode);
    const description = await h.code('text(await describeTool("subagent")); text(await describeTool("subagent_group_results"));');
    assert.equal(description.isError, false);
    assert.match(JSON.stringify(description.content), /API_TEST_WORKER_DESCRIPTION/);
    assert.match(JSON.stringify(description.content), /subagent_group_results/);
    const firstParentCall = (await h.calls()).find((call) => call.child === "parent");
    assert.match(firstParentCall.transcript, /API_TEST_WORKER_DESCRIPTION/, "session-start replacement reaches the first request");
    if (mode === "on") assert.match(firstParentCall.transcript, /Codemode:/, "Pi's script guidance is not overwritten");

    const result = await h.code(`
      const tasks = ["one", "two"].map(name => ({ action: "launch", agent: "worker", name, task: "GATE:" + name }));
      const outcomes = await Promise.allSettled(tasks.map(task => tools.subagent(task)));
      outcomes.forEach((outcome, i) => text({ name: tasks[i].name, startup: outcome.status }));
      text(await tools.subagent_group_results({ children: tasks.filter((_, i) => outcomes[i].status === "fulfilled").map(task => task.name) }));
      try { await tools.subagent_group_results({ children: ["one"], unexpected: true }); } catch (error) { text(String(error)); }
      try { await tools.subagent({ action: "launch", agent: "worker", task: "Removed field", tasks: [] }); } catch (error) { text(String(error)); }
    `);
    assert.equal(result.isError, false);
    const body = JSON.stringify(result.content);
    assert.match(body, /grouped for: one, two/);
    assert.match(body, /subagent_group_results does not take: unexpected/);
    assert.match(body, /launch does not take: tasks/);
    assert.equal((await h.records()).size, 2, "unknown keys were not stripped and did not create an extra child");
    assert.equal((await h.notifications()).length, 0);
    assert(result.nestedCalls?.calls.some((call) => call.name === "subagent"));
    assert(result.nestedCalls?.calls.some((call) => call.name === "subagent_group_results"));
    assert(!(await h.results()).some((item) => item.toolName === "subagent"), "nested calls do not create standalone transcript tool results");

    const directUnknown = await h.call("subagent_group_results", { children: ["one"], unexpected: true });
    assert.equal(directUnknown.isError, true);
    assert.match(JSON.stringify(directUnknown.content), /subagent_group_results does not take: unexpected\. It takes: children\./);
    const directBatch = await h.call("subagent", { action: "launch", agent: "worker", task: "Removed field", shared: "common" });
    assert.equal(directBatch.isError, true);
    assert.match(JSON.stringify(directBatch.content), /launch does not take: shared/);
    assert.equal((await h.records()).size, 2, "direct unknown fields also fail before creating a child");

    await h.release("one");
    await h.waitFor(async () => (await h.records()).get("one")?.run.state === "completed");
    assert.equal((await h.notifications()).length, 0, "one successful member does not wake the parent");
    const status = await h.code('text(await tools.subagent({ action: "status" }));');
    assert.match(JSON.stringify(status.content), /completion result held for grouped notification/);

    // An unrelated child remains independent of the selected group.
    const launchOther = mode === "on"
      ? await h.call("subagent", { action: "launch", agent: "worker", name: "other", task: "GATE:other" })
      : await h.code('text(await tools.subagent({ action: "launch", agent: "worker", name: "other", task: "GATE:other" }));');
    assert.equal(launchOther.isError, false);
    await h.release("other");
    await h.waitFor(async () => (await h.notifications()).length === 1);
    assert.match(JSON.stringify(await h.notifications()), /Sidekick other completed/);
    await h.release("two");
    await h.waitFor(async () => (await h.notifications()).length === 2);
    const notices = await h.notifications();
    assert.match(JSON.stringify(notices), /Combined results for 2 assignments/);
    assert.equal(notices.filter((entry) => entry.type === "custom_message" && entry.customType === "sidekicks:group").length, 1);
    await h.idle();
    assert([...(await h.records()).values()].every((child) => !child.run.groupId && child.run.delivered));

    const repeated = mode === "on" ? await h.call("subagent_group_results", { children: ["one", "two"] })
      : await h.code('text(await tools.subagent_group_results({ children: ["one", "two"] }));');
    assert.match(JSON.stringify(repeated.content), /Nothing to group/);
    assert.equal((await h.notifications()).length, 2);

    await writeFile(join(h.agent, "sidekicks/worker.md"), "---\nname: worker\ndescription: REFRESHED_WORKER_DESCRIPTION\n---\n");
    await h.rpc.request({ type: "prompt", message: "/qa-reload" });
    const refreshed = await h.code('text(await describeTool("subagent"));');
    assert.match(JSON.stringify(refreshed.content), /REFRESHED_WORKER_DESCRIPTION/);
    assert.doesNotMatch(JSON.stringify(refreshed.content), /API_TEST_WORKER_DESCRIPTION/);
  });
}

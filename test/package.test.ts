import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RpcConnection, type RpcEvent } from "../src/rpc.ts";
import type { ChildRecord } from "../src/manager.ts";

test("packed package installs in isolated Pi and delivers a child question and result", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sidekicks-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { encoding: "utf8" }));
  const paths = pack.files.map((file: { path: string }) => file.path) as string[];
  assert(paths.includes("LICENSE") && paths.includes("src/index.ts") && paths.includes("src/child.ts"));
  assert(paths.every((path) => /^(src\/|docs\/|scripts\/migrate-sidekick-sessions\.ts$|README\.md$|LICENSE$|package\.json$)/.test(path)),
    `Unexpected distribution files: ${paths.join(", ")}`);
  execFileSync("tar", ["-xzf", join(directory, pack.filename), "-C", directory]);
  const agent = join(directory, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(join(agent, "sidekicks"));
  await symlink(resolve("test/fixtures/faux-provider.ts"), join(agent, "extensions", "faux-provider.ts"));
  await writeFile(join(agent, "sidekicks", "worker.md"), "---\nname: worker\ndescription: Test worker\n---\nComplete the delegated task.\n");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    SIDEKICKS_TEST_LOG: join(directory, "calls.jsonl"), SIDEKICKS_TEST_SCENARIO: "orchestrator" };
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  execFileSync(process.execPath, [cli, "install", join(directory, "package")], { cwd: directory, env, encoding: "utf8", timeout: 15_000 });
  const rpc = new RpcConnection({ command: process.execPath, args: [cli, "--mode", "rpc", "--no-approve",
    "--session", join(directory, "parent.jsonl"), "--model", "sidekicks-test/scripted"] }, { cwd: directory, env });
  t.after(() => rpc.stop());
  let finalSeen = false;
  const done = new Promise<void>((resolve) => {
    rpc.on("event", (event: RpcEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalSeen ||= event.message.content.some((block) => block.type === "text" && block.text.includes("FINAL:"));
      }
      if (event.type === "agent_settled" && finalSeen) resolve();
    });
  });
  await rpc.request({ type: "prompt", message: "Delegate to worker. Answer its question and report completion." });
  await done;
  const entries = (await rpc.request({ type: "get_entries" })).entries;
  const notifications = entries.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sidekicks:"));
  assert.deepEqual(notifications.map((entry) => entry.type === "custom_message" && entry.customType), ["sidekicks:question", "sidekicks:result"]);
  const last = entries.findLast((entry) => entry.type === "custom" && entry.customType === "sidekicks:state");
  assert(last?.type === "custom");
  const child = last.data as ChildRecord;
  assert.equal(child.run.state, "completed");
  assert.match(await readFile(child.sessionPath, "utf8"), /Answer to \w+:/);
  assert.match(await readFile(join(directory, "agent", "settings.json"), "utf8"), /package/);
  await rpc.stop();
});

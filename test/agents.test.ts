import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "../src/agents.ts";

const agent = (body: string) => `---\nname: worker\ndescription: Work on a task\nsystemPromptMode: replace\ntools: [read, bash]\n${body}\n---\nInstructions.\n`;

test("trusted project agents override user agents; unknown legacy keys are ignored", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  const user = join(dir, "user");
  const project = join(dir, ".pi", "sidekicks");
  await mkdir(user); await mkdir(project, { recursive: true });
  await writeFile(join(user, "worker.md"), agent("model: local/user\nthinking: low"));
  await writeFile(join(project, "worker.md"), agent("model: local/project\nthinking: high"));
  assert.equal(discoverAgents(dir, true, { userDirectory: user })[0].model, "local/project");
  const untrusted = discoverAgents(dir, false, { userDirectory: user });
  assert.equal(untrusted[0].model, "local/user");
  assert.equal(untrusted[0].instructions.trim(), "Instructions.");
});

test("agent instructions may be omitted or whitespace-only", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  for (const body of ["", "\n  \n"]) {
    await writeFile(join(dir, "general.md"), `---\nname: general\ndescription: General-purpose agent\n---\n${body}`);
    const [definition] = discoverAgents(dir, false, { userDirectory: dir });
    assert.equal(definition.name, "general");
    assert.equal(definition.instructions.trim(), "");
  }
});

test("configured agentsDir replaces default folders for trusted and untrusted projects", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  const userDirectory = join(dir, "user");
  const project = join(dir, ".pi", "sidekicks");
  const custom = join(dir, "custom definitions");
  for (const path of [userDirectory, project, custom]) await mkdir(path, { recursive: true });
  await writeFile(join(userDirectory, "bad.md"), "Not an agent definition");
  await writeFile(join(project, "bad.md"), "Not an agent definition");
  await writeFile(join(custom, "worker.md"), agent("model: local/custom"));
  for (const trusted of [false, true]) {
    for (const agentsDir of [custom, "custom definitions"]) {
      const definitions = discoverAgents(dir, trusted, { userDirectory, agentsDir });
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0].model, "local/custom");
    }
  }
});

test("legacy agents folders are not discovered", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  const legacy = join(dir, ".pi", "agents");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "bad.md"), "Not an agent definition");
  assert.deepEqual(discoverAgents(dir, true, { userDirectory: join(dir, "sidekicks") }), []);
});

test("invalid or missing configured directories fail without falling back", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  await writeFile(join(dir, "worker.md"), agent(""));
  for (const agentsDir of ["", "  ", null, false, 42, []]) {
    assert.throws(() => discoverAgents(dir, false, { userDirectory: dir, agentsDir }), /sidekicks.agentsDir/);
  }
  assert.throws(() => discoverAgents(dir, false, { userDirectory: dir, agentsDir: "missing" }), { code: "ENOENT" });
});

test("invalid and duplicate agent definitions fail visibly", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  await writeFile(join(dir, "one.md"), agent("thinking: wrong"));
  assert.throws(() => discoverAgents(dir, false, { userDirectory: dir }), /Invalid thinking/);
  await writeFile(join(dir, "one.md"), agent(""));
  await writeFile(join(dir, "two.md"), agent(""));
  assert.throws(() => discoverAgents(dir, false, { userDirectory: dir }), /Duplicate agent/);
});

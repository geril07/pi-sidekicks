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
  assert.equal(discoverAgents(dir, true, { userDirectory: user }).agents[0].model, "local/project");
  const untrusted = discoverAgents(dir, false, { userDirectory: user }).agents;
  assert.equal(untrusted[0].model, "local/user");
  assert.equal(untrusted[0].instructions.trim(), "Instructions.");
});

test("agent instructions may be omitted or whitespace-only", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  for (const body of ["", "\n  \n"]) {
    await writeFile(join(dir, "general.md"), `---\nname: general\ndescription: General-purpose agent\n---\n${body}`);
    const [definition] = discoverAgents(dir, false, { userDirectory: dir }).agents;
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
      const { agents, problems } = discoverAgents(dir, trusted, { userDirectory, agentsDir });
      assert.equal(agents.length, 1);
      assert.equal(agents[0].model, "local/custom");
      assert.deepEqual(problems, [], "the default folders are not read at all");
    }
  }
});

test("legacy agents folders are not discovered", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  const legacy = join(dir, ".pi", "agents");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "bad.md"), "Not an agent definition");
  assert.deepEqual(discoverAgents(dir, true, { userDirectory: join(dir, "sidekicks") }), { agents: [], problems: [] });
});

test("invalid or missing configured directories fail without falling back", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  await writeFile(join(dir, "worker.md"), agent(""));
  for (const agentsDir of ["", "  ", null, false, 42, []]) {
    assert.throws(() => discoverAgents(dir, false, { userDirectory: dir, agentsDir }), /sidekicks.agentsDir/);
  }
  assert.throws(() => discoverAgents(dir, false, { userDirectory: dir, agentsDir: "missing" }), { code: "ENOENT" });
});

test("an invalid definition is reported and skipped without hiding the valid ones", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  await writeFile(join(dir, "good.md"), "---\nname: good\ndescription: Works\n---\n");
  await writeFile(join(dir, "no-description.md"), "---\nname: lonely\n---\n");
  await writeFile(join(dir, "no-frontmatter.md"), "Not an agent definition");
  await writeFile(join(dir, "bad-thinking.md"), agent("thinking: wrong"));
  await writeFile(join(dir, "bad-model.md"), "---\nname: m\ndescription: d\nmodel: 7\n---\n");
  await writeFile(join(dir, "broken-yaml.md"), "---\nname: [unclosed\n---\n");
  const { agents, problems } = discoverAgents(dir, false, { userDirectory: dir });
  assert.deepEqual(agents.map((definition) => definition.name), ["good"]);
  assert.deepEqual(problems.map(({ path }) => path.slice(dir.length + 1)).sort(),
    ["bad-model.md", "bad-thinking.md", "broken-yaml.md", "no-description.md", "no-frontmatter.md"]);
  assert(problems.every(({ reason }) => reason.length > 0 && !reason.includes(dir)), "reasons are stated without repeating the path");
  assert.match(problems.find(({ path }) => path.endsWith("bad-thinking.md"))!.reason, /invalid thinking "wrong"/);
});

test("a duplicate name keeps the first file and reports the second", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-agents-");
  await writeFile(join(dir, "one.md"), agent("model: local/first"));
  await writeFile(join(dir, "two.md"), agent("model: local/second"));
  const { agents, problems } = discoverAgents(dir, false, { userDirectory: dir });
  assert.deepEqual(agents.map((definition) => definition.model), ["local/first"]);
  assert.equal(problems.length, 1);
  assert(problems[0].path.endsWith("two.md"));
  assert.match(problems[0].reason, /duplicate name worker/);
});

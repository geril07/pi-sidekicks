import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoverRoles } from "../src/roles.ts";

const role = (body: string) => `---\nname: worker\ndescription: Work on a task\nsystemPromptMode: replace\ntools: [read, bash]\n${body}\n---\nInstructions.\n`;

test("trusted project roles override user roles; unknown legacy keys are ignored", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-roles-");
  const user = join(dir, "user");
  const project = join(dir, ".pi", "agents");
  await mkdir(user); await mkdir(project, { recursive: true });
  await writeFile(join(user, "worker.md"), role("model: local/user\nthinking: low"));
  await writeFile(join(project, "worker.md"), role("model: local/project\nthinking: high"));
  assert.equal(discoverRoles(dir, true, user)[0].model, "local/project");
  const untrusted = discoverRoles(dir, false, user);
  assert.equal(untrusted[0].model, "local/user");
  assert.equal(untrusted[0].instructions.trim(), "Instructions.");
});

test("invalid and duplicate role definitions fail visibly", async () => {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-roles-");
  await writeFile(join(dir, "one.md"), role("thinking: wrong"));
  assert.throws(() => discoverRoles(dir, false, dir), /Invalid thinking/);
  await writeFile(join(dir, "one.md"), role(""));
  await writeFile(join(dir, "two.md"), role(""));
  assert.throws(() => discoverRoles(dir, false, dir), /Duplicate role/);
});

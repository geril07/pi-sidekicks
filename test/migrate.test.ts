import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/migrate-sidekick-sessions.ts");
const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-20T10:00:00.000Z", cwd: "/tmp/project" });
const state = (id: string, owner = PARENT) => JSON.stringify({ type: "custom", customType: "sidekicks:state", id: `state-${id}`, parentId: null, timestamp: "2026-10-20T10:00:01.000Z", data: { id, ownerSessionId: owner } });

async function fixture(children = [CHILD]) {
  const dir = await mkdtemp("/tmp/opencode/sidekicks-migrate-");
  const project = join(dir, "sessions", "--project--");
  const parentFile = join(project, "2026-10-20T10-00-00-000Z_parent.jsonl");
  await mkdir(project, { recursive: true });
  await writeFile(parentFile, [header(PARENT), ...children.map((child) => state(child))].join("\n") + "\n");
  for (const child of children) {
    const old = join(dir, "sidekick-sessions", child);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "session.jsonl"), `${header(child)}\n`);
  }
  const destination = (child: string) => join(project, "2026-10-20T10-00-00-000Z_parent", "sidekicks", child);
  return { dir, project, parentFile, destination };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("migration dry-run leaves the legacy child in place", async () => {
  const h = await fixture();
  try {
    const result = run(["--agent-dir", h.dir, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: 1 to move/);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD, "session.jsonl")), true);
    assert.equal(existsSync(h.destination(CHILD)), false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("migration moves a child beside its parent and rollback restores it", async () => {
  const h = await fixture();
  const manifest = join(h.dir, "manifest.json");
  try {
    const applied = run(["--agent-dir", h.dir, "--apply", "--manifest", manifest]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD)), false);
    assert.equal(existsSync(join(h.destination(CHILD), "session.jsonl")), true);
    const saved = JSON.parse(await readFile(manifest, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.moves[0].from, join(h.dir, "sidekick-sessions", CHILD));
    assert.equal(saved.moves[0].to, h.destination(CHILD));

    const rolledBack = run(["--rollback", manifest]);
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD, "session.jsonl")), true);
    assert.equal(existsSync(h.destination(CHILD)), false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("a live writer lock blocks --apply unless --skip-live is given", async () => {
  const h = await fixture();
  try {
    await writeFile(join(h.dir, "sidekick-sessions", CHILD, "session.jsonl.lock"), JSON.stringify({ pid: process.pid }));
    const refused = run(["--agent-dir", h.dir, "--apply"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refusing to apply with 1 live writer lock/);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD)), true);

    const skipped = run(["--agent-dir", h.dir, "--apply", "--skip-live"]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /skip \S+: live writer lock/);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD)), true);
    assert.equal(existsSync(h.destination(CHILD)), false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("an existing destination is a conflict, not an overwrite", async () => {
  const h = await fixture();
  try {
    await mkdir(h.destination(CHILD), { recursive: true });
    await writeFile(join(h.destination(CHILD), "session.jsonl"), "already there\n");
    const result = run(["--agent-dir", h.dir, "--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /destination already exists/);
    assert.equal(existsSync(join(h.dir, "sidekick-sessions", CHILD, "session.jsonl")), true);
    assert.equal(await readFile(join(h.destination(CHILD), "session.jsonl"), "utf8"), "already there\n");
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("a child without a parent state entry is reported as an orphan", async () => {
  const h = await fixture([CHILD]);
  try {
    const orphan = join(h.dir, "sidekick-sessions", OTHER);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "session.jsonl"), `${header(OTHER)}\n`);
    const result = run(["--agent-dir", h.dir, "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(h.destination(CHILD)), true);
    assert.equal(existsSync(join(orphan, "session.jsonl")), true);
    assert.match(result.stdout, new RegExp(`orphan ${OTHER}`));
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

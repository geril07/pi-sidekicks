/**
 * Move sidekick child folders from the old global store into the parent session's
 * `<parent-stem>/sidekicks/` directory. Run with all Pi sessions closed.
 *
 * The extension derives the new path from the parent session file, so this script
 * never edits parent transcripts. It only moves directories and writes a manifest
 * that can be replayed in reverse with --rollback.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const STATE_ENTRY = "sidekicks:state";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

type Parent = { file: string; id: string };
type Move = { childId: string; from: string; to: string };
type Manifest = { version: 1; createdAt: string; moves: Move[] };

function usage(): string {
  return [
    "Usage: npm run migrate:sidekick-sessions -- [options]",
    "",
    "  --dry-run             Print the plan without moving anything (default)",
    "  --apply               Move child folders and write a manifest",
    "  --skip-live           With --apply, skip children whose writer lock is live",
    "  --agent-dir <path>    Pi agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)",
    "  --manifest <path>     Manifest path (default: <agent-dir>/sidekick-migration-<time>.json)",
    "  --rollback <path>     Move every recorded child back to the old store",
    "  -h, --help            Show this help",
    "",
    "All Pi sessions must be closed before --apply. The script refuses to move a",
    "child whose session.jsonl.lock still has a live writer.",
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const options = {
    apply: false,
    skipLive: false,
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
    manifest: undefined as string | undefined,
    rollback: undefined as string | undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--skip-live") options.skipLive = true;
    else if (arg === "--agent-dir") options.agentDir = argv[++index] ?? "";
    else if (arg === "--manifest") options.manifest = argv[++index];
    else if (arg === "--rollback") options.rollback = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function currentBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Mirrors Manager's dead-writer rule: unreadable or ambiguous locks are treated as live. */
function liveLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  let owner: { pid?: unknown; childPid?: unknown; bootId?: unknown };
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return true;
  }
  if (!owner || typeof owner !== "object") return true;
  const boot = currentBootId();
  if (typeof owner.bootId === "string" && owner.bootId && boot !== undefined && owner.bootId !== boot) return false;
  if (!pidAlive(owner.pid)) {
    if (owner.childPid === undefined || !pidAlive(owner.childPid)) return false;
  }
  return true;
}

async function scanParents(sessionsRoot: string) {
  const parents = new Map<string, Parent>();
  const childToParent = new Map<string, Parent>();
  const ambiguous = new Set<string>();
  const warnings: string[] = [];

  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(sessionsRoot, project.name);
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(projectDir, name);
      let parentId: string | undefined;
      const childIds = new Set<string>();
      const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (parentId === undefined) {
            try {
              const header = JSON.parse(line) as { type?: unknown; id?: unknown };
              if (header?.type !== "session" || typeof header.id !== "string" || !UUID.test(header.id)) break;
              parentId = header.id;
            } catch {
              break;
            }
          }
          if (!line.includes(STATE_ENTRY)) continue;
          let entry: { type?: unknown; customType?: unknown; data?: { id?: unknown; ownerSessionId?: unknown } };
          try {
            entry = JSON.parse(line);
          } catch {
            warnings.push(`${file}: skipped an unreadable ${STATE_ENTRY} line`);
            continue;
          }
          if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
          const data = entry.data;
          if (!data || typeof data.id !== "string" || !UUID.test(data.id)) continue;
          if (typeof data.ownerSessionId !== "string" || data.ownerSessionId !== parentId) {
            warnings.push(`${file}: child ${data.id} has a mismatched ownerSessionId`);
            continue;
          }
          childIds.add(data.id);
        }
      } finally {
        reader.close();
      }
      if (!parentId || childIds.size === 0) continue;
      const known = parents.get(parentId);
      if (known && known.file !== file) {
        warnings.push(`parent ${parentId} appears in ${known.file} and ${file}; children from both are not migrated`);
        for (const childId of childIds) ambiguous.add(childId);
        continue;
      }
      const parent = { file, id: parentId };
      parents.set(parentId, parent);
      for (const childId of childIds) {
        const previous = childToParent.get(childId);
        if (previous && previous.file !== file) {
          warnings.push(`child ${childId} is referenced by ${previous.file} and ${file}`);
          ambiguous.add(childId);
          continue;
        }
        childToParent.set(childId, parent);
      }
    }
  }
  for (const childId of ambiguous) childToParent.delete(childId);
  return { childToParent, warnings };
}

function defaultManifestPath(agentDir: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(agentDir, `sidekick-migration-${stamp}.json`);
}

function writeManifest(path: string, moves: Move[]): void {
  const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), moves };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function rollback(path: string): number {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (error) {
    console.error(`Cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.moves)) {
    console.error(`Not a version 1 sidekick migration manifest: ${path}`);
    return 1;
  }
  let moved = 0;
  const conflicts: string[] = [];
  for (const move of [...manifest.moves].reverse()) {
    if (!existsSync(move.to)) {
      if (existsSync(move.from)) continue;
      conflicts.push(`missing both ${move.from} and ${move.to}`);
      continue;
    }
    if (existsSync(move.from)) {
      conflicts.push(`both ${move.from} and ${move.to} exist`);
      continue;
    }
    mkdirSync(dirname(move.from), { recursive: true, mode: 0o700 });
    renameSync(move.to, move.from);
    moved++;
  }
  console.log(`Rolled back ${moved} of ${manifest.moves.length} children.`);
  for (const conflict of conflicts) console.error(`conflict: ${conflict}`);
  return conflicts.length ? 1 : 0;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.rollback) return rollback(resolve(options.rollback));

  const agentDir = resolve(options.agentDir);
  const sessionsRoot = join(agentDir, "sessions");
  const legacyRoot = join(agentDir, "sidekick-sessions");
  if (!existsSync(legacyRoot)) {
    console.log(`Nothing to migrate: ${legacyRoot} does not exist.`);
    return 0;
  }
  if (!existsSync(sessionsRoot)) {
    console.error(`No sessions directory: ${sessionsRoot}`);
    return 1;
  }

  const { childToParent, warnings } = await scanParents(sessionsRoot);
  const moves: Move[] = [];
  const live: string[] = [];
  const conflicts: string[] = [];
  const orphans: string[] = [];

  for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) {
      if (!entry.name.startsWith(".")) warnings.push(`${legacyRoot}/${entry.name}: not a child directory; skipped`);
      continue;
    }
    const childId = entry.name;
    const from = join(legacyRoot, childId);
    const parent = childToParent.get(childId);
    if (!parent) {
      orphans.push(childId);
      continue;
    }
    const to = join(dirname(parent.file), basename(parent.file, ".jsonl"), "sidekicks", childId);
    if (existsSync(to)) {
      conflicts.push(`${childId}: destination already exists at ${to}`);
      continue;
    }
    if (liveLock(join(from, "session.jsonl.lock"))) {
      live.push(childId);
      continue;
    }
    moves.push({ childId, from, to });
  }

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(`${options.apply ? "Plan" : "Dry run"}: ${moves.length} to move, ${live.length} live lock${live.length === 1 ? "" : "s"}, ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}, ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}.`);
  for (const move of moves) console.log(`  ${options.apply ? "move" : "would move"} ${move.childId}\n    ${move.from}\n -> ${move.to}`);
  for (const childId of live) console.log(`  skip ${childId}: live writer lock`);
  for (const conflict of conflicts) console.error(`  conflict ${conflict}`);
  for (const childId of orphans) console.log(`  orphan ${childId}: no parent sidekicks:state entry`);

  if (!options.apply) {
    console.log("No files changed. Re-run with --apply after closing all Pi sessions.");
    return 0;
  }
  if (live.length && !options.skipLive) {
    console.error(`Refusing to apply with ${live.length} live writer lock${live.length === 1 ? "" : "s"}. Close Pi, or pass --skip-live to move the rest.`);
    return 1;
  }

  const manifestPath = resolve(options.manifest ?? defaultManifestPath(agentDir));
  if (moves.length) {
    // Write the plan before moving: a crash mid-run still leaves a rollback record.
    writeManifest(manifestPath, moves);
    console.log(`Manifest: ${manifestPath}`);
  }
  const moved: Move[] = [];
  const failed: string[] = [];
  for (const move of moves) {
    try {
      mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
      renameSync(move.from, move.to);
      moved.push(move);
    } catch (error) {
      failed.push(`${move.childId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (moved.length) {
    writeManifest(manifestPath, moved);
    console.log(`Moved ${moved.length} of ${moves.length} children. Manifest: ${manifestPath}`);
    console.log("Start Pi and verify with: ccusage pi daily");
  } else {
    console.log("Nothing moved.");
  }
  for (const failure of failed) console.error(`  failed ${failure}`);
  return conflicts.length || failed.length ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

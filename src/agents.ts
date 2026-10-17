import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Thinking } from "./manager.ts";

export interface Agent { name: string; description: string; instructions: string; model?: string; thinking?: Thinking }
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function discoverAgents(cwd: string, trusted: boolean, options: { userDirectory?: string; agentsDir?: unknown } = {}): Agent[] {
  const agents = new Map<string, Agent>();
  const userDirectory = options.userDirectory ?? join(getAgentDir(), "sidekicks");
  let directories = trusted ? [userDirectory, join(cwd, ".pi", "sidekicks")] : [userDirectory];
  if (options.agentsDir !== undefined) {
    if (typeof options.agentsDir !== "string" || !options.agentsDir.trim()) throw new Error("sidekicks.agentsDir must be a nonempty path string");
    const path = options.agentsDir;
    directories = [resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)];
  }
  for (const directory of directories) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (options.agentsDir === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const names = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const path = join(directory, entry.name);
      const { frontmatter: data, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
      if (typeof data.name !== "string" || !data.name.trim() || typeof data.description !== "string" || !data.description.trim()) {
        throw new Error(`Agent needs name and description: ${path}`);
      }
      if (names.has(data.name)) throw new Error(`Duplicate agent ${data.name} in ${directory}`);
      if (data.model !== undefined && (typeof data.model !== "string" || !data.model.trim())) throw new Error(`Invalid model in ${path}`);
      if (data.thinking !== undefined && !thinkingLevels.includes(data.thinking as Thinking)) throw new Error(`Invalid thinking in ${path}`);
      names.add(data.name);
      agents.set(data.name, { name: data.name, description: data.description, instructions: body,
        model: data.model as string | undefined, thinking: data.thinking as Thinking | undefined });
    }
  }
  return [...agents.values()];
}

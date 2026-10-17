import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Thinking } from "./manager.ts";

export interface Role { name: string; description: string; instructions: string; model?: string; thinking?: Thinking }
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function discoverRoles(cwd: string, trusted: boolean, userDirectory = join(getAgentDir(), "agents")): Role[] {
  const roles = new Map<string, Role>();
  const directories = trusted ? [userDirectory, join(cwd, ".pi", "agents")] : [userDirectory];
  for (const directory of directories) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const names = new Set<string>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const path = join(directory, entry.name);
      const { frontmatter: data, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
      if (typeof data.name !== "string" || !data.name.trim() || typeof data.description !== "string" || !data.description.trim() || !body.trim()) {
        throw new Error(`Role needs name, description, and instructions: ${path}`);
      }
      if (names.has(data.name)) throw new Error(`Duplicate role ${data.name} in ${directory}`);
      if (data.model !== undefined && (typeof data.model !== "string" || !data.model.trim())) throw new Error(`Invalid model in ${path}`);
      if (data.thinking !== undefined && !thinkingLevels.includes(data.thinking as Thinking)) throw new Error(`Invalid thinking in ${path}`);
      names.add(data.name);
      roles.set(data.name, { name: data.name, description: data.description, instructions: body,
        model: data.model as string | undefined, thinking: data.thinking as Thinking | undefined });
    }
  }
  return [...roles.values()];
}

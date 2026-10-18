import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { RpcConnection, type Invocation, type RpcEvent } from "./rpc.ts";

export type Thinking = RpcSessionState["thinkingLevel"];
export type RunState = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export interface Question { id: string; text: string; delivered?: boolean }
export interface Run { groupId?: string; id: string; state: RunState; question?: Question; result?: string; resultFile?: string; delivered: boolean; startedAt?: number; endedAt?: number }
export interface ChildRecord {
  id: string; ownerSessionId: string; name: string; agent: string; instructions: string;
  cwd: string; sessionPath: string; model: string; thinking: Thinking; run: Run;
  questions?: (Question & { runId: string })[];
}
export interface ChildSnapshot {
  id: string; name: string; agent: string; model: string; thinking: Thinking;
  /** Only set when the child works somewhere other than the parent's directory. */
  cwd?: string;
  run: Run; connected: boolean; activity: string; sessionPath: string;
  questions?: (Question & { runId: string })[];
}
interface Child {
  record: ChildRecord; rpc?: RpcConnection; release?: () => void; closing?: Promise<void>;
  stopRequested: boolean; operation: boolean; settling: boolean; activity: string;
  controller: AbortController; lastError?: string; lastAborted?: boolean;
  seenQuestions: Set<string>;
}
export interface ManagerOptions {
  ownerSessionId: string; directory: string; cwd: string; trusted: boolean;
  invocation: Invocation; env?: NodeJS.ProcessEnv;
  persist: (record: ChildRecord) => void;
  deliver: (child: ChildSnapshot, kind: "question" | "result", question?: Question & { runId?: string }) => void;
  deliverGroup?: (members: ChildSnapshot[]) => void;
  changed: () => void;
  dialog: (child: ChildSnapshot, request: RpcExtensionUIRequest, signal: AbortSignal) => Promise<RpcExtensionUIResponse | undefined>;
  restored?: ChildRecord[];
}

const active = (state: RunState) => state === "starting" || state === "running" || state === "waiting";
export const MAX_ACTIVE_ASSIGNMENTS = 64;
const DETACHED = "Parent session detached. Continue explicitly; no automatic replay; previous external effects may be unknown.";
const CHILD_BRIEFING = [
  "You are a sidekick: a child agent working for a parent agent. Messages that start with \"Sidekicks task:\" are your assignment; \"guidance\", \"follow-up\" and \"answer\" messages also come from the parent.",
  "Your final message is returned to the parent as your result, and the parent sees nothing else you did. Make it self-contained: what you did or found, evidence (paths, line numbers, commands), and what is still open.",
  "If you are blocked on something only the parent can decide, call ask_parent (wait:true pauses until answered, wait:false asks while you continue). Do not ask to reconfirm an adequate task. Do not delegate to other agents.",
].join("\n");
export const frame = (kind: string, text: string) => `Sidekicks ${kind}:\n${text}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const argKeys = ["path", "file_path", "command", "pattern", "query", "url", "agent", "action"];
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Bounded, human-readable label for the tool a child is running. */
export function describeTool(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const key = argKeys.find((candidate) => typeof record[candidate] === "string" && record[candidate]);
  return oneLine(key ? `${name} ${record[key] as string}` : name).slice(0, 160);
}

const bootId = (): string | undefined => {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; }
  catch { return undefined; }
};

const pidAlive = (pid: unknown) => {
  if (!Number.isInteger(pid)) return true;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Removes a lock from a previous boot or when both recorded processes are gone. Anything unreadable or
 * ambiguous counts as live: two writers on one transcript is worse than a refused resume.
 * PIDs are per-machine, so this assumes the lock was written on this host.
 */
function removeDeadLock(lock: string): boolean {
  let contents: string;
  try { contents = readFileSync(lock, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  let owner: { pid?: unknown; childPid?: unknown; bootId?: unknown };
  try { owner = JSON.parse(contents); } catch { return false; }
  if (!owner || typeof owner !== "object") return false;
  const currentBoot = bootId();
  const rebooted = typeof owner.bootId === "string" && !!owner.bootId && currentBoot !== undefined && owner.bootId !== currentBoot;
  if (!rebooted && (pidAlive(owner.pid) || (owner.childPid !== undefined && pidAlive(owner.childPid)))) return false;
  // Re-read so a lock another parent just replaced is not removed.
  if (readFileSync(lock, "utf8") !== contents) return false;
  unlinkSync(lock);
  return true;
}

export class Manager {
  private options: ManagerOptions;
  private children = new Map<string, Child>();
  private alive = true;

  constructor(options: ManagerOptions) {
    this.options = options;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    for (const saved of options.restored ?? []) {
      if (saved.ownerSessionId !== options.ownerSessionId || !/^[\da-f-]{36}$/.test(saved.id)) continue;
      if (saved.sessionPath !== join(options.directory, `${saved.id}.jsonl`)) continue;
      const record = structuredClone(saved);
      if (active(record.run.state)) {
        record.run = { ...record.run, state: "interrupted", endedAt: Date.now(), question: undefined,
          result: DETACHED, delivered: true };
      }
      record.questions = [];
      this.children.set(record.id, this.child(record));
    }
  }

  private child(record: ChildRecord): Child {
    return { record, stopRequested: false, operation: false, settling: false,
      activity: "detached", controller: new AbortController(), seenQuestions: new Set() };
  }

  snapshot(): ChildSnapshot[] { return [...this.children.values()].map((child) => this.view(child)); }

  private view(child: Child): ChildSnapshot {
    const { id, name, agent, model, thinking, run, sessionPath, cwd } = child.record;
    return { id, name, agent, model, thinking, ...(cwd !== this.options.cwd ? { cwd } : {}), run: structuredClone(run), sessionPath,
      connected: !!child.rpc && !child.closing, activity: child.activity, questions: structuredClone(child.record.questions ?? []) };
  }

  private assertAlive(): void { if (!this.alive) throw new Error("Parent session is no longer active"); }
  private find(ref: string): Child {
    this.assertAlive();
    const child = this.children.get(ref) ?? [...this.children.values()].find((candidate) => candidate.record.name === ref);
    if (!child) throw new Error(`Unknown child: ${ref}. Known: ${[...this.children.values()].map((known) => known.record.name).join(", ") || "none"}`);
    return child;
  }
  private uniqueName(wanted: string | undefined, agent: string, taken = new Set([...this.children.values()].map((child) => child.record.name))): string {
    if (wanted !== undefined) {
      if (taken.has(wanted)) throw new Error(`Name already used by another child: ${wanted}`);
      return wanted;
    }
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? agent : `${agent}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  private capacity(count = 1): void {
    this.assertAlive();
    if ([...this.children.values()].filter((child) => active(child.record.run.state)).length + count > MAX_ACTIVE_ASSIGNMENTS) {
      throw new Error(`At most ${MAX_ACTIVE_ASSIGNMENTS} assignments may be active, including waiting questions. Stop or finish work before adding this assignment or batch.`);
    }
  }
  private commit(child: Child, persist = true): void {
    if (!this.alive) return;
    if (persist) this.options.persist(structuredClone(child.record));
    this.options.changed();
  }

  async launch(input: { agent: string; instructions: string; name?: string; task: string; model: string; thinking: Thinking; cwd?: string; groupId?: string }, signal?: AbortSignal): Promise<ChildSnapshot> {
    this.capacity();
    const id = randomUUID();
    const name = this.uniqueName(input.name, input.agent);
    const child = this.child({ id, ownerSessionId: this.options.ownerSessionId, name,
      agent: input.agent, instructions: input.instructions, cwd: input.cwd ?? this.options.cwd,
      sessionPath: join(this.options.directory, `${id}.jsonl`), model: input.model, thinking: input.thinking,
      run: { groupId: input.groupId, id: randomUUID(), state: "starting", delivered: false, startedAt: Date.now() } });
    this.children.set(id, child);
    this.commit(child);
    await this.start(child, frame("task", input.task), signal);
    return this.view(child);
  }

  async send(id: string, message: string, signal?: AbortSignal): Promise<ChildSnapshot> {
    const child = this.find(id);
    if (child.record.run.state === "waiting" || child.record.run.question) throw new Error("Answer the pending question by questionId, or stop the child.");
    if (child.operation || child.settling || child.closing) throw new Error("Child is changing state; retry after it settles.");
    if (child.record.run.state === "running" && child.rpc) {
      child.operation = true;
      try {
        signal?.throwIfAborted();
        const accepted = await child.rpc.request({ type: "prompt", message: frame("guidance", message), streamingBehavior: "steer" });
        if (accepted.disposition === "handled") throw new Error("A child extension consumed the guidance instead of delivering it.");
      } finally { child.operation = false; }
    } else {
      this.capacity();
      const previous = child.record.run;
      if (previous.groupId && previous.state === "completed" && !previous.delivered) {
        previous.delivered = true;
        this.options.deliver(this.view(child), "result");
        this.commit(child);
      }
      if (previous.state === "interrupted" || previous.state === "cancelled") {
        message = `Your previous run was ${previous.state === "cancelled" ? "stopped" : "interrupted"}. You may have made partial changes. Check the current state before repeating anything.\n${message}`;
      }
      child.record.run = { id: randomUUID(), state: "starting", delivered: false, startedAt: Date.now() };
      this.releaseHeld();
      child.lastError = undefined;
      this.commit(child);
      await this.start(child, frame("follow-up", message), signal);
    }
    return this.view(child);
  }

  async answer(id: string, questionId: string, answer: string, signal?: AbortSignal): Promise<ChildSnapshot> {
    const child = this.find(id);
    const run = child.record.run;
    const question = child.record.questions?.find((q) => q.id === questionId);
    if (question) {
      if (child.operation || child.closing || !child.rpc || child.stopRequested) throw new Error("Child is changing state; retry after it settles.");
      child.operation = true;
      try {
        signal?.throwIfAborted();
        const accepted = await child.rpc.request({ type: "prompt", message: `/sidekicks-answer ${JSON.stringify({ id: questionId, text: answer })}` });
        if (accepted.disposition !== "handled") throw new Error("Child did not handle the correlated answer command");
        child.record.questions = child.record.questions?.filter((q) => q.id !== questionId);
        this.commit(child);
      } finally { child.operation = false; }
      return this.view(child);
    }
    if (child.operation || child.settling || run.state !== "waiting" || run.question?.id !== questionId) {
      throw new Error("No matching settled question: answer is stale, duplicate, or not ready.");
    }
    run.question = undefined;
    run.state = "starting";
    run.delivered = false;
    this.commit(child);
    await this.start(child, frame(`answer to ${questionId}`, answer), signal);
    return this.view(child);
  }

  private async start(child: Child, message: string, signal?: AbortSignal): Promise<void> {
    child.operation = true;
    child.stopRequested = false;
    child.lastAborted = false;
    let submitted = false;
    const abort = () => { void this.stop(child.record.id).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (!child.rpc) await this.open(child);
      this.assertAlive();
      signal?.throwIfAborted();
      if (child.stopRequested) throw new Error("Launch cancelled");
      child.record.run.state = "running";
      child.activity = "working";
      this.commit(child);
      submitted = true;
      const accepted = await child.rpc!.request({ type: "prompt", message });
      if (accepted.disposition !== "started") throw new Error(`Child prompt was ${accepted.disposition}, not started`);
    } catch (error) {
      await this.disconnect(child);
      if (this.alive) this.finish(child, child.stopRequested ? "cancelled" : submitted ? "interrupted" : "failed", errorText(error), false);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      child.operation = false;
    }
  }

  private async open(child: Child): Promise<void> {
    const record = child.record;
    if (!existsSync(record.cwd)) throw new Error(`Working directory no longer exists: ${record.cwd}`);
    const lock = `${record.sessionPath}.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (!removeDeadLock(lock)) throw error;
        fd = openSync(lock, "wx", 0o600);
      } catch (retry) {
        if ((retry as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Child session is locked by a live process: ${lock}`);
        throw retry;
      }
    }
    const writer = { pid: process.pid, bootId: bootId(), token: randomUUID(), owner: this.options.ownerSessionId };
    let lockContents = JSON.stringify(writer);
    child.release = () => {
      try { if (readFileSync(lock, "utf8") === lockContents) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    try { writeFileSync(fd, lockContents); }
    finally { closeSync(fd); }
    const promptPath = join(this.options.directory, `${record.id}.agent.md`);
    writeFileSync(promptPath, `${record.instructions.trim()}\n\n${CHILD_BRIEFING}`.trim(), { mode: 0o600 });
    const args = [...this.options.invocation.args, "--mode", "rpc", "--session", record.sessionPath,
      "--append-system-prompt", promptPath, "-e", fileURLToPath(new URL("./child.ts", import.meta.url))];
    if (!this.options.trusted) args.push("--no-approve");
    child.controller = new AbortController();
    child.lastError = undefined;
    const rpc = new RpcConnection({ command: this.options.invocation.command, args }, {
      cwd: record.cwd, env: { ...(this.options.env ?? process.env), PI_SIDEKICKS_CHILD: record.id,
        // pi-notifier recognises children by these names, and would otherwise announce every child as a session.
        PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_CHILD_AGENT: record.agent },
    });
    child.rpc = rpc;
    lockContents = JSON.stringify({ ...writer, childPid: rpc.process.pid });
    writeFileSync(lock, lockContents, { mode: 0o600 });
    rpc.on("event", (event: RpcEvent) => {
      if (this.alive && child.rpc === rpc) this.receive(child, event);
    });
    rpc.on("fault", (error: Error) => { child.lastError = error.message; });
    rpc.on("exit", () => {
      child.controller.abort();
      record.questions = [];
      this.commit(child);
      if (this.alive && active(record.run.state) && !child.operation) {
        this.finish(child, child.stopRequested ? "cancelled" : "interrupted", child.lastError ?? "Child process exited before completion.");
      }
      void this.disconnect(child).catch(() => {});
    });
    const catalog = await rpc.request({ type: "get_available_models" });
    const matches = catalog.models.filter((model) => `${model.provider}/${model.id}` === record.model || model.id === record.model);
    if (matches.length !== 1) throw new Error(`Model must match exactly one available child model: ${record.model}`);
    const model = matches[0];
    await rpc.request({ type: "set_model", provider: model.provider, modelId: model.id });
    const { levels } = await rpc.request({ type: "get_available_thinking_levels" });
    if (!levels.includes(record.thinking)) throw new Error(`Thinking ${record.thinking} is unsupported by ${record.model}; supported: ${levels.join(", ")}`);
    await rpc.request({ type: "set_thinking_level", level: record.thinking });
    const state = await rpc.request({ type: "get_state" });
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount) throw new Error("A child extension started work before readiness; refusing to queue the assignment behind it.");
    if (`${state.model?.provider}/${state.model?.id}` !== `${model.provider}/${model.id}` || state.thinkingLevel !== record.thinking) {
      throw new Error("Child did not retain the requested model/thinking");
    }
    if (state.sessionFile !== record.sessionPath) throw new Error("Child opened a different session file");
    record.model = `${model.provider}/${model.id}`;
  }

  private receive(child: Child, event: RpcEvent): void {
    const run = child.record.run;
    if (event.type === "extension_ui_request") {
      const rpc = child.rpc!;
      void Promise.resolve().then(() => this.options.dialog(this.view(child), event, child.controller.signal)).then((response) => {
        if (response && this.alive && child.rpc === rpc && !child.controller.signal.aborted) rpc.respond(response);
      }).catch(() => {
        if (this.alive && child.rpc === rpc && !child.controller.signal.aborted) rpc.respond({ type: "extension_ui_response", id: event.id, cancelled: true });
      });
    } else if (event.type === "entry_appended" && run.state !== "starting" && event.entry.type === "custom" && event.entry.customType === "sidekicks:question") {
      const data = event.entry.data as { action?: string; id?: string; text?: string; wait?: boolean } | undefined;
      if (!active(run.state) || child.stopRequested) return;
      if (data?.action === "asked" && typeof data.id === "string" && typeof data.text === "string") {
        if (child.seenQuestions.has(data.id)) return;
        child.seenQuestions.add(data.id);
        if (data.wait === false) {
          const question = { id: data.id, text: data.text, runId: run.id, delivered: true };
          (child.record.questions ??= []).push(question);
          this.commit(child);
          this.options.deliver(this.view(child), "question", question);
          return;
        }
        if (run.question) {
          this.finish(child, "interrupted", "Child emitted a second pending question.");
          void this.disconnect(child);
          return;
        }
        run.question = { id: data.id, text: data.text };
      } else if (data?.action === "withdrawn" && run.question?.id === data.id) {
        run.question = undefined;
      }
      this.commit(child);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      child.lastError = event.message.stopReason === "error"
        ? event.message.errorMessage ?? `Assistant ${event.message.stopReason}` : undefined;
      child.lastAborted = event.message.stopReason === "aborted";
    } else if (event.type === "tool_execution_start") {
      child.activity = describeTool(event.toolName, event.args);
      this.commit(child, false);
    } else if (event.type === "tool_execution_end") {
      child.activity = "working";
      this.commit(child, false);
    } else if (event.type === "message_update") {
      const type = event.assistantMessageEvent.type;
      const activity = type === "thinking_delta" ? "thinking" : type === "text_delta" ? "responding" : undefined;
      if (activity && child.activity !== activity) { child.activity = activity; this.commit(child, false); }
    } else if (event.type === "agent_settled" && run.state !== "starting" && active(run.state) && !child.settling) {
      child.settling = true;
      void this.settle(child, event.aborted).catch((error) => {
        child.settling = false;
        if (this.alive) this.finish(child, child.stopRequested ? "cancelled" : "interrupted", errorText(error));
      });
    }
  }

  private async settle(child: Child, aborted: boolean): Promise<void> {
    if (child.stopRequested) { child.settling = false; this.finish(child, "cancelled", "Stopped by parent."); return; }
    const run = child.record.run;
    if (run.question) {
      run.state = "waiting";
      child.activity = "waiting for answer";
      child.settling = false;
      this.commit(child);
      if (!run.question.delivered && this.alive) {
        run.question.delivered = true;
        this.options.deliver(this.view(child), "question", run.question);
        this.commit(child);
      }
      return;
    }
    child.activity = "settling";
    this.commit(child, false);
    const result = await child.rpc!.request({ type: "get_last_assistant_text" });
    child.settling = false;
    if (!this.alive) return;
    if (child.stopRequested) this.finish(child, "cancelled", "Stopped by parent.");
    else if (child.lastError) this.finish(child, "failed", child.lastError);
    else if (aborted || child.lastAborted) this.finish(child, "interrupted", "Child aborted without a parent stop or question.");
    else this.finish(child, "completed", result.text ?? "(No assistant text)");
  }

  private finish(child: Child, state: RunState, result: string, deliver = true): void {
    const run = child.record.run;
    if (!active(run.state)) return;
    if (!deliver) run.groupId = undefined;
    run.state = state;
    run.endedAt = Date.now();
    run.question = undefined;
    if (state !== "completed") child.record.questions = [];
    run.resultFile = this.saveResult(child.record, result);
    run.result = result.length <= 24_000 ? result : `${result.slice(0, 24_000)}\n[Truncated. Full result: ${run.resultFile ?? child.record.sessionPath}]`;
    child.activity = state;
    if (run.groupId && state === "cancelled") run.delivered = true;
    this.commit(child);
    if (deliver && !(run.groupId && state === "completed") && !run.delivered && this.alive) {
      run.delivered = true;
      this.options.deliver(this.view(child), "result");
      this.commit(child);
    }
    this.releaseHeld();
  }

  /** One readable file per run, beside the transcript. */
  private saveResult(record: ChildRecord, result: string): string | undefined {
    const { run } = record;
    const path = join(this.options.directory, `${record.id}.${run.id}.result.md`);
    const time = (value?: number) => value === undefined ? "" : new Date(value).toISOString();
    const header = [["child", record.name], ["agent", record.agent], ["model", record.model], ["thinking", record.thinking],
      ["state", run.state], ["started", time(run.startedAt)], ["ended", time(run.endedAt)], ["transcript", record.sessionPath]]
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    try {
      writeFileSync(`${path}.tmp`, `---\n${header.join("\n")}\n---\n\n${result}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return path;
    } catch {
      // The registry copy and the child transcript still hold the result, so a full disk must not fail the run.
      return undefined;
    }
  }

  releaseHeld(): void {
    if (!this.alive || !this.options.deliverGroup) return;
    const groups = new Set(this.snapshot().map((child) => child.run.groupId).filter((id) => id !== undefined));
    for (const id of groups) {
      const members = [...this.children.values()].filter((child) => child.record.run.groupId === id);
      if (members.some((child) => active(child.record.run.state))) continue;
      const held = members.filter((child) => child.record.run.state === "completed" && !child.record.run.delivered);
      if (!held.length) continue;
      this.options.deliverGroup(members.map((child) => this.view(child)));
      for (const child of held) { child.record.run.delivered = true; this.commit(child); }
    }
  }

  async launchBatch(inputs: Parameters<Manager["launch"]>[0][], results: "together" | "each" = "together", signal?: AbortSignal): Promise<{ child: ChildSnapshot; error?: string }[]> {
    this.capacity(inputs.length);
    const taken = new Set(this.snapshot().map((child) => child.name));
    const groupId = randomUUID();
    const named = inputs.map((input) => {
      const name = this.uniqueName(input.name, input.agent, taken);
      taken.add(name);
      return { ...input, name, groupId: results === "together" ? groupId : undefined };
    });
    return Promise.all(named.map(async (input) => {
      try { return { child: await this.launch(input, signal) }; }
      catch (error) {
        const child = [...this.children.values()].find((child) => child.record.name === input.name);
        if (!child) throw error;
        return { child: this.view(child), error: errorText(error) };
      }
    }));
  }

  async stop(id: string): Promise<ChildSnapshot> {
    const child = this.find(id);
    child.stopRequested = true;
    child.record.questions = [];
    child.controller.abort();
    if (child.rpc && !child.closing) {
      try { await child.rpc.request({ type: "clear_queue" }, 1000); await child.rpc.request({ type: "abort" }, 2000); }
      catch { /* Termination below is also required when RPC is unresponsive. */ }
    }
    await this.disconnect(child);
    this.finish(child, "cancelled", "Stopped by parent. External effects are not undone.");
    this.commit(child);
    return this.view(child);
  }

  private disconnect(child: Child): Promise<void> {
    if (child.closing) return child.closing;
    const rpc = child.rpc;
    return child.closing = (async () => {
      child.controller.abort();
      if (rpc) await rpc.stop();
      if (child.rpc === rpc) child.rpc = undefined;
      child.release?.();
      child.release = undefined;
      child.activity = "detached";
    })().finally(() => { child.closing = undefined; if (this.alive) this.options.changed(); });
  }

  async shutdown(persist = true): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    const children = [...this.children.values()];
    for (const child of children) {
      child.controller.abort();
      child.record.questions = [];
      if (active(child.record.run.state)) {
        child.record.run = { ...child.record.run, state: "interrupted", endedAt: Date.now(), question: undefined,
          result: DETACHED, delivered: true };
      }
      if (persist) this.options.persist(structuredClone(child.record));
    }
    await Promise.all(children.map((child) => this.disconnect(child)));
  }
}

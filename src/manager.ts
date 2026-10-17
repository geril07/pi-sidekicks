import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { RpcConnection, type Invocation, type RpcEvent } from "./rpc.ts";

export type Thinking = RpcSessionState["thinkingLevel"];
export type RunState = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export interface Question { id: string; text: string; delivered?: boolean }
export interface Run { id: string; state: RunState; question?: Question; result?: string; delivered: boolean }
export interface ChildRecord {
  id: string; ownerSessionId: string; name: string; role: string; instructions: string;
  cwd: string; sessionPath: string; model: string; thinking: Thinking; run: Run;
}
export interface ChildSnapshot {
  id: string; name: string; role: string; model: string; thinking: Thinking;
  run: Run; connected: boolean; activity: string; sessionPath: string;
}
interface Child {
  record: ChildRecord; rpc?: RpcConnection; release?: () => void; closing?: Promise<void>;
  stopRequested: boolean; operation: boolean; settling: boolean; activity: string;
  controller: AbortController; lastError?: string; lastAborted?: boolean;
}
export interface ManagerOptions {
  ownerSessionId: string; directory: string; cwd: string; trusted: boolean;
  invocation: Invocation; env?: NodeJS.ProcessEnv;
  persist: (record: ChildRecord) => void;
  deliver: (child: ChildSnapshot, kind: "question" | "result") => void;
  changed: () => void;
  dialog: (child: ChildSnapshot, request: RpcExtensionUIRequest, signal: AbortSignal) => Promise<RpcExtensionUIResponse | undefined>;
  restored?: ChildRecord[];
}

const active = (state: RunState) => state === "starting" || state === "running" || state === "waiting";
export const frame = (kind: string, text: string) => `Sidekicks ${kind}:\n${text}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
        record.run = { ...record.run, state: "interrupted", question: undefined,
          result: "Parent session detached. Continue explicitly; previous external effects may be unknown.", delivered: true };
      }
      this.children.set(record.id, this.child(record));
    }
  }

  private child(record: ChildRecord): Child {
    return { record, stopRequested: false, operation: false, settling: false,
      activity: "detached", controller: new AbortController() };
  }

  snapshot(): ChildSnapshot[] { return [...this.children.values()].map((child) => this.view(child)); }

  private view(child: Child): ChildSnapshot {
    const { id, name, role, model, thinking, run, sessionPath } = child.record;
    return { id, name, role, model, thinking, run: structuredClone(run), sessionPath,
      connected: !!child.rpc && !child.closing, activity: child.activity };
  }

  private assertAlive(): void { if (!this.alive) throw new Error("Parent session is no longer active"); }
  private find(id: string): Child {
    this.assertAlive();
    const child = this.children.get(id);
    if (!child) throw new Error(`Unknown child: ${id}`);
    return child;
  }
  private capacity(): void {
    this.assertAlive();
    if ([...this.children.values()].filter((child) => active(child.record.run.state)).length >= 3) {
      throw new Error("Three assignments are already active, including waiting questions. Stop or finish one first.");
    }
  }
  private commit(child: Child, persist = true): void {
    if (!this.alive) return;
    if (persist) this.options.persist(structuredClone(child.record));
    this.options.changed();
  }

  async launch(input: { role: string; instructions: string; name?: string; task: string; model: string; thinking: Thinking }, signal?: AbortSignal): Promise<ChildSnapshot> {
    this.capacity();
    const id = randomUUID();
    const child = this.child({ id, ownerSessionId: this.options.ownerSessionId, name: input.name ?? input.role,
      role: input.role, instructions: input.instructions, cwd: this.options.cwd,
      sessionPath: join(this.options.directory, `${id}.jsonl`), model: input.model, thinking: input.thinking,
      run: { id: randomUUID(), state: "starting", delivered: false } });
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
      child.record.run = { id: randomUUID(), state: "starting", delivered: false };
      child.lastError = undefined;
      this.commit(child);
      await this.start(child, frame("follow-up", message), signal);
    }
    return this.view(child);
  }

  async answer(id: string, questionId: string, answer: string, signal?: AbortSignal): Promise<ChildSnapshot> {
    const child = this.find(id);
    const run = child.record.run;
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
    const lock = `${record.sessionPath}.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Child session is locked: ${lock}. Verify its owner is gone before removing a stale lock.`);
      throw error;
    }
    const writer = { pid: process.pid, token: randomUUID(), owner: this.options.ownerSessionId };
    let lockContents = JSON.stringify(writer);
    child.release = () => {
      try { if (readFileSync(lock, "utf8") === lockContents) unlinkSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    try { writeFileSync(fd, lockContents); }
    finally { closeSync(fd); }
    const promptPath = join(this.options.directory, `${record.id}.role.md`);
    writeFileSync(promptPath, `${record.instructions}\n\nUse ask_parent directly when genuinely blocked. Do not delegate to other agents.`, { mode: 0o600 });
    const args = [...this.options.invocation.args, "--mode", "rpc", "--session", record.sessionPath,
      "--append-system-prompt", promptPath, "-e", fileURLToPath(new URL("./child.ts", import.meta.url))];
    if (!this.options.trusted) args.push("--no-approve");
    child.controller = new AbortController();
    child.lastError = undefined;
    const rpc = new RpcConnection({ command: this.options.invocation.command, args }, {
      cwd: record.cwd, env: { ...(this.options.env ?? process.env), PI_SIDEKICKS_CHILD: record.id },
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
      const data = event.entry.data as { action?: string; id?: string; text?: string } | undefined;
      if (!active(run.state) || child.stopRequested) return;
      if (data?.action === "asked" && typeof data.id === "string" && typeof data.text === "string") {
        if (run.question?.id === data.id) return;
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
      child.activity = `using ${event.toolName}`.slice(0, 160);
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
        this.options.deliver(this.view(child), "question");
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
    run.state = state;
    run.question = undefined;
    run.result = result.length <= 24_000 ? result : `${result.slice(0, 24_000)}\n[Truncated. Full result: ${child.record.sessionPath}]`;
    child.activity = state;
    this.commit(child);
    if (deliver && !run.delivered && this.alive) {
      run.delivered = true;
      this.options.deliver(this.view(child), "result");
      this.commit(child);
    }
  }

  async stop(id: string): Promise<ChildSnapshot> {
    const child = this.find(id);
    child.stopRequested = true;
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
      if (active(child.record.run.state)) {
        child.record.run = { ...child.record.run, state: "interrupted", question: undefined,
          result: "Parent session detached. Continue explicitly; no automatic replay.", delivered: true };
      }
      if (persist) this.options.persist(structuredClone(child.record));
    }
    await Promise.all(children.map((child) => this.disconnect(child)));
  }
}

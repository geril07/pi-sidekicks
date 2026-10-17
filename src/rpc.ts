import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type {
  JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse,
} from "@earendil-works/pi-coding-agent";

export type RpcEvent = JsonAgentSessionEvent | RpcExtensionUIRequest;
type ResponseData<K> = Extract<RpcResponse, { command: K; success: true }> extends { data: infer D } ? D : undefined;
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export interface Invocation { command: string; args: string[] }

export class RpcConnection extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, Pending>();
  private serial = 0;
  private ended = false;
  private stopping?: Promise<void>;
  private buffer = "";

  constructor(invocation: Invocation, options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    super();
    this.process = spawn(invocation.command, invocation.args, {
      cwd: options.cwd, env: options.env ?? process.env,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    const decoder = new StringDecoder("utf8");
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer += decoder.write(chunk);
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.length > 8 * 1024 * 1024) return this.fail(new Error("RPC line exceeds 8 MiB"));
        if (!line.trim()) continue;
        let message: RpcResponse | RpcEvent;
        try { message = JSON.parse(line); }
        catch { return this.fail(new Error("Child wrote invalid RPC JSON")); }
        if (!message || typeof message.type !== "string") return this.fail(new Error("Invalid RPC message"));
        if (message.type === "response") {
          const pending = message.id && this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id!);
          clearTimeout(pending.timer);
          if (message.success) pending.resolve("data" in message ? message.data : undefined);
          else pending.reject(new Error(message.error));
        } else {
          this.emit("event", message);
        }
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.fail(new Error("RPC line exceeds 8 MiB"));
    });
    this.process.stderr.resume();
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => {
      this.process.once("close", (code, signal) => {
        this.ended = true;
        this.rejectPending(new Error(`Pi child closed (${signal ?? code})`));
        this.emit("exit", { code, signal });
        resolve();
      });
    });
  }

  request<K extends RpcCommand["type"]>(command: Extract<RpcCommand, { type: K }>, timeout = 30_000): Promise<ResponseData<K>> {
    if (this.ended || this.stopping) return Promise.reject(new Error("Pi child is closed"));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  respond(response: RpcExtensionUIResponse): void { this.write(response); }

  private write(message: object): void {
    if (this.ended || this.process.stdin.destroyed) return this.fail(new Error("Pi stdin is closed"));
    this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.fail(error); });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.emit("fault", error);
    void this.stop();
  }

  stop(): Promise<void> {
    return this.stopping ??= this.closeProcess();
  }

  private async closeProcess(): Promise<void> {
    this.process.stdin.end();
    const pid = this.process.pid;
    const signal = (name: NodeJS.Signals) => {
      if (!pid) return;
      try { process.kill(process.platform === "win32" ? pid : -pid, name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.emit("fault", error); }
    };
    await delay(200);
    signal("SIGTERM");
    await delay(300);
    signal("SIGKILL");
    await this.closed;
  }
}

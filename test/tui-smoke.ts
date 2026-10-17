import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function smoke(mode: "fullscreen" | "regular", scenario = "orchestrator") {
  const directory = mkdtempSync(`/tmp/opencode/sidekicks-tui-${mode}-`);
  const agent = join(directory, "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  mkdirSync(join(agent, "sidekicks"));
  symlinkSync(join(root, "test/fixtures/faux-provider.ts"), join(agent, "extensions/faux-provider.ts"));
  writeFileSync(join(agent, "sidekicks/worker.md"), "---\nname: worker\ndescription: Test worker\n---\nWork on the task.\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: mode, checkForUpdates: false }));
  const log = join(directory, "calls.jsonl");
  const socket = `sidekicks-${process.pid}-${mode}-${scenario}`;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const screen = () => tmux("capture-pane", "-p", "-t", "qa");
  const records = (): Record<string, any>[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const waitFor = async (predicate: (text: string) => boolean, description: string) => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const text = screen();
      if (predicate(text)) return text;
      await delay(50);
    }
    throw new Error(`${mode}: ${description}; evidence: ${directory}`);
  };
  const literal = (text: string) => { tmux("send-keys", "-t", "qa", "-l", "--", text); };
  const keys = (...values: string[]) => { tmux("send-keys", "-t", "qa", ...values); };
  const shortcut = (letter: string) => literal(`\x1b${String.fromCharCode(letter.charCodeAt(0) - 96)}`);
  const paneDead = () => tmux("display-message", "-p", "-t", "qa", "#{pane_dead}").trim() === "1";
  const noLocks = () => assert.equal([...globSync("sidekicks/**/*.lock", { cwd: agent })].length, 0, "graceful shutdown releases child writer locks");
  const command = ["env", `PI_CODING_AGENT_DIR=${agent}`, `SIDEKICKS_TEST_LOG=${log}`,
    `SIDEKICKS_TEST_SCENARIO=${scenario}`, "PI_PROGRAM_STATUS=0", process.execPath, cli,
    "--no-approve", "--session", join(directory, "parent.jsonl"), "-e", join(root, "src/index.ts"),
    "--model", "sidekicks-test/scripted"].map(quote).join(" ");
  try {
    tmux("new-session", "-d", "-s", "qa", "-x", "200", "-y", "56", "-c", directory, command);
    tmux("set-option", "-t", "qa", "remain-on-exit", "on");
    const startup = await waitFor((text) => text.includes("(sidekicks-test) scripted"), "startup");
    assert(!/[▸▾] sidekicks/.test(startup), "widget must stay hidden before any children exist");
    writeFileSync(join(directory, "startup.txt"), startup);
    literal("Delegate this task to a worker and answer its question.");
    keys("Enter");
    if (scenario === "dialogs") {
      await waitFor((text) => text.includes("worker: QA confirm"), "bridged confirmation");
      keys("Down", "Enter");
      await waitFor((text) => text.includes("worker: QA select"), "bridged selection");
      keys("Down", "Enter");
      await waitFor((text) => text.includes("worker: QA input"), "bridged input");
      literal("qa-value");
      keys("Enter");
      await waitFor((text) => text.includes("worker: QA editor"), "bridged multiline editor");
      keys("C-a", "C-k");
      literal("edited");
      keys("Enter");
    }
    await waitFor((text) => text.includes("FINAL: child completion received automatically."), "automatic question/answer/completion");
    if (scenario === "dialogs") {
      assert.deepEqual(records().find((record) => record.dialogs)?.dialogs,
        { confirmed: false, selected: "B", input: "qa-value", edited: "edited" });
      writeFileSync(join(directory, "dialogs.txt"), screen());
      shortcut("q");
      await waitFor(paneDead, "dialog session shutdown");
      noLocks();
      console.log(`PASS ${mode} dialogs: ${directory}`);
      return;
    }
    const baseline = records().length;
    const summaryRow = (text: string) => {
      const row = text.split("\n").findIndex((line) => /[▸▾] sidekicks/.test(line));
      assert(row >= 0, "Missing sidekicks summary");
      return row + 1;
    };
    await waitFor((text) => /▸ sidekicks .*1 done/.test(text), "collapsed summary after completion");
    keys("Down");
    await waitFor((text) => text.includes("esc back"), "down on an empty editor enters the list");
    keys("Down", "Enter");
    await waitFor((text) => text.includes(".jsonl"), "enter shows row details");
    keys("Escape");
    await waitFor((text) => !text.includes("esc back") && /▸ sidekicks/.test(text), "escape returns to the editor and collapses");
    literal("alpha beta");
    keys("Left", "Left", "Left", "Left");
    await waitFor((text) => text.includes("alpha beta"), "draft");
    keys("Down");
    await delay(300);
    assert(!screen().includes("esc back"), "down must not steal a non-empty draft");
    keys("C-a", "C-k");
    literal("alpha beta");
    keys("Left", "Left", "Left", "Left");
    literal("X");
    await waitFor((text) => text.includes("alpha Xbeta"), "mid-line insertion");
    keys("C-a", "C-k");
    keys("Down");
    await waitFor((text) => text.includes("esc back"), "list reopened on an empty editor");
    shortcut("d");
    await waitFor((text) => text.includes("QA unrelated dialog"), "unrelated input dialog");
    literal("dialogvalue");
    keys("Left", "Left", "Left", "Left", "Left");
    literal("X");
    keys("Enter");
    await waitFor((text) => text.includes("QA dialog result: dialogXvalue"), "dialog owns text/arrows/Enter");
    await waitFor((text) => !text.includes("esc back"), "dialog releases list focus");
    if (mode === "fullscreen") {
      const click = (text: string) => { const row = summaryRow(text); literal(`\x1b[<0;2;${row}M\x1b[<0;2;${row}m`); };
      const current = screen();
      const expanded = current.includes("▾ sidekicks");
      click(current);
      await waitFor((text) => text.includes(expanded ? "▸ sidekicks" : "▾ sidekicks"), "summary click toggles");
      click(screen());
      await waitFor((text) => text.includes(expanded ? "▾ sidekicks" : "▸ sidekicks"), "summary click toggles back");
    }
    assert.equal(records().length, baseline, "status observation must not call the model");
    writeFileSync(join(directory, "navigation.txt"), screen());
    keys("C-a", "C-k");
    const pasted = Array.from({ length: 40 }, (_, i) => `paste-line-${String(i).padStart(2, "0")}`).join("\n");
    literal(`\x1b[200~${pasted}\x1b[201~`);
    await waitFor((text) => text.includes("[paste #"), "collapsed paste");
    keys("Down");
    await delay(300);
    assert(!screen().includes("esc back"), "down must not enter the list over a pasted draft");
    assert(screen().includes("[paste #"), "paste preserved");
    keys("Enter");
    await waitFor(() => records().length > baseline, "submit expanded paste");
    const content = JSON.stringify(records().at(-1)!.lastUser);
    assert(content.includes("paste-line-00") && content.includes("paste-line-39") && !content.includes("[paste #"));
    shortcut("q");
    await waitFor(paneDead, "shutdown");
    noLocks();
    console.log(`PASS ${mode}: ${directory}`);
  } catch (error) {
    try { writeFileSync(join(directory, "failure.txt"), screen()); } catch { /* The tmux server may have exited. */ }
    throw error;
  } finally {
    try { tmux("kill-server"); } catch { /* The tmux server may have exited. */ }
  }
}

for (const mode of ["fullscreen", "regular"] as const) await smoke(mode);
await smoke("fullscreen", "dialogs");

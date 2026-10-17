"""Optional real-terminal smoke: python test/tui-smoke.py (requires tmux)."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"


def smoke(mode, scenario="orchestrator"):
    directory = Path(tempfile.mkdtemp(prefix=f"sidekicks-tui-{mode}-", dir="/tmp/opencode"))
    agent = directory / "agent"
    (agent / "extensions").mkdir(parents=True)
    (agent / "agents").mkdir()
    (agent / "extensions/faux-provider.ts").symlink_to(ROOT / "test/fixtures/faux-provider.ts")
    (agent / "agents/worker.md").write_text("---\nname: worker\ndescription: Test worker\n---\nWork on the task.\n")
    (agent / "settings.json").write_text(json.dumps({"tuiMode": mode, "checkForUpdates": False}))
    log = directory / "calls.jsonl"
    socket = f"sidekicks-{os.getpid()}-{mode}"

    def tmux(*args, check=True):
        return subprocess.run(["tmux", "-L", socket, "-f", "/dev/null", *args],
                              text=True, capture_output=True, check=check).stdout

    def screen():
        return tmux("capture-pane", "-p", "-t", "qa")

    def wait_for(predicate, description):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            text = screen()
            if predicate(text):
                return text
            time.sleep(0.05)
        (directory / "failure.txt").write_text(screen())
        raise AssertionError(f"{mode}: {description}; evidence: {directory}")

    def literal(text):
        tmux("send-keys", "-t", "qa", "-l", "--", text)

    def keys(*values):
        tmux("send-keys", "-t", "qa", *values)

    def shortcut(letter):
        literal("\x1b" + chr(ord(letter) - 96))

    command = shlex.join(["env", f"PI_CODING_AGENT_DIR={agent}", f"SIDEKICKS_TEST_LOG={log}",
                          f"SIDEKICKS_TEST_SCENARIO={scenario}", "PI_PROGRAM_STATUS=0", "node", str(CLI),
                          "--no-approve", "--session", str(directory / "parent.jsonl"),
                          "-e", str(ROOT / "src/index.ts"), "--model", "sidekicks-test/scripted"])
    try:
        tmux("new-session", "-d", "-s", "qa", "-x", "200", "-y", "56", "-c", str(directory), command)
        tmux("set-option", "-t", "qa", "remain-on-exit", "on")
        wait_for(lambda text: "Sidekicks" in text, "startup")
        literal("Delegate this task to a worker and answer its question.")
        keys("Enter")
        if scenario == "dialogs":
            wait_for(lambda text: "worker: QA confirm" in text, "bridged confirmation")
            keys("Down", "Enter")
            wait_for(lambda text: "worker: QA select" in text, "bridged selection")
            keys("Down", "Enter")
            wait_for(lambda text: "worker: QA input" in text, "bridged input")
            literal("qa-value")
            keys("Enter")
            wait_for(lambda text: "worker: QA editor" in text, "bridged multiline editor")
            keys("C-a", "C-k")
            literal("edited")
            keys("Enter")
        wait_for(lambda text: "FINAL: child completion received automatically." in text, "automatic question/answer/completion")
        if scenario == "dialogs":
            records = [json.loads(line) for line in log.read_text().splitlines()]
            result = next(record["dialogs"] for record in records if "dialogs" in record)
            assert result == {"confirmed": False, "selected": "B", "input": "qa-value", "edited": "edited"}, result
            (directory / "dialogs.txt").write_text(screen())
            shortcut("q")
            wait_for(lambda _text: tmux("display-message", "-p", "-t", "qa", "#{pane_dead}").strip() == "1", "dialog session shutdown")
            print(f"PASS {mode} dialogs: {directory}")
            return
        baseline = len(log.read_text().splitlines())
        literal("alpha beta")
        keys("Left", "Left", "Left", "Left")
        wait_for(lambda text: "alpha beta" in text, "draft")
        cursor = tmux("display-message", "-p", "-t", "qa", "#{cursor_x}").strip()
        shortcut("n")
        wait_for(lambda text: "Esc editor" in text, "navigation overlay")
        keys("Down", "Right", "Escape")
        wait_for(lambda text: "Esc editor" not in text, "navigation close")
        assert tmux("display-message", "-p", "-t", "qa", "#{cursor_x}").strip() == cursor
        literal("X")
        wait_for(lambda text: "alpha Xbeta" in text, "mid-line cursor preservation")
        keys("Left")
        literal("Y")
        wait_for(lambda text: "alpha YXbeta" in text, "normal arrows outside navigation")

        shortcut("n")
        wait_for(lambda text: "Esc editor" in text, "navigation reopened")
        shortcut("d")
        wait_for(lambda text: "QA unrelated dialog" in text, "unrelated input dialog")
        literal("dialogvalue")
        keys("Left", "Left", "Left", "Left", "Left")
        literal("X")
        keys("Enter")
        wait_for(lambda text: "QA dialog result: dialogXvalue" in text, "dialog owns text/arrows/Enter")
        keys("Escape")
        wait_for(lambda text: "Esc editor" not in text and "alpha YXbeta" in text, "dialog/navigation cleanup")

        if mode == "fullscreen":
            text = screen()
            row = next(i + 1 for i, line in enumerate(text.splitlines()) if "Sidekicks ▾" in line)
            literal(f"\x1b[<0;2;{row}M\x1b[<0;2;{row}m")
            collapsed = wait_for(lambda text: "Sidekicks ▸" in text, "summary click collapse")
            row = next(i + 1 for i, line in enumerate(collapsed.splitlines()) if "Sidekicks ▸" in line)
            literal(f"\x1b[<0;2;{row}M\x1b[<0;2;{row}m")
            wait_for(lambda text: "Sidekicks ▾" in text, "summary click expand")
        assert len(log.read_text().splitlines()) == baseline, "status observation must not call the model"
        (directory / "navigation.txt").write_text(screen())

        keys("C-a", "C-k")
        pasted = "\n".join(f"paste-line-{i:02d}" for i in range(40))
        literal(f"\x1b[200~{pasted}\x1b[201~")
        wait_for(lambda text: "[paste #" in text, "collapsed paste")
        shortcut("n")
        wait_for(lambda text: "Esc editor" in text, "navigation with paste")
        keys("Escape")
        wait_for(lambda text: "Esc editor" not in text and "[paste #" in text, "paste preserved")
        keys("Enter")
        wait_for(lambda _text: len(log.read_text().splitlines()) > baseline, "submit expanded paste")
        last = json.loads(log.read_text().splitlines()[-1])
        content = json.dumps(last["lastUser"])
        assert "paste-line-00" in content and "paste-line-39" in content and "[paste #" not in content

        shortcut("n")
        wait_for(lambda text: "Esc editor" in text, "navigation before shutdown")
        shortcut("q")
        wait_for(lambda _text: tmux("display-message", "-p", "-t", "qa", "#{pane_dead}").strip() == "1", "shutdown closes navigation")
        assert not list(agent.glob("sidekicks/**/*.lock")), "graceful shutdown releases child writer locks"
        print(f"PASS {mode}: {directory}")
    finally:
        tmux("kill-server", check=False)


if __name__ == "__main__":
    for mode in ["fullscreen", "regular"]:
        smoke(mode)
    smoke("fullscreen", "dialogs")

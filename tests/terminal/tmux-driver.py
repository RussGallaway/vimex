"""Offline smoke test in an isolated tmux server; never touches existing sessions."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="vimex-tmux-") as temporary:
    socket = str(pathlib.Path(temporary) / "server.sock")
    environment = {**os.environ, "HERDR_ENV": "0", "XDG_CONFIG_HOME": temporary, "XDG_STATE_HOME": temporary}
    environment.pop("TMUX", None)
    config = pathlib.Path(temporary) / "tmux.conf"
    config.write_text("set-window-option -g remain-on-exit on\n")
    command = [shutil.which("tmux"), "-S", socket, "-f", str(config)]

    def tmux(*args, check=True):
        return subprocess.run([*command, *args], cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check, text=True)

    def wait_for(text):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            captured = tmux("capture-pane", "-p", "-t", "vimex-test", check=False)
            if captured.returncode:
                raise AssertionError(f"tmux capture failed: {captured.stderr.strip()}")
            frame = captured.stdout
            if text in frame:
                return frame
            time.sleep(0.05)
        raise AssertionError(f"Missing {text!r} in tmux frame: {frame!r}")

    try:
        tmux("new-session", "-d", "-s", "vimex-test", "-x", "100", "-y", "28", shutil.which("bun"), "run", "apps/tui/src/main.tsx", "--demo")
        wait_for("Welcome to Vimex")
        tmux("send-keys", "-t", "vimex-test", "-l", "i")
        wait_for("INSERT")
        tmux("send-keys", "-t", "vimex-test", "-l", "tmux draft preserved")
        wait_for("tmux draft preserved")
        tmux("send-keys", "-t", "vimex-test", "Escape")
        wait_for("NORMAL")
        tmux("send-keys", "-t", "vimex-test", "-l", ":")
        wait_for("COMMAND")
        tmux("send-keys", "-t", "vimex-test", "-l", "q")
        tmux("send-keys", "-t", "vimex-test", "Enter")
        deadline = time.monotonic() + 8
        status = ""
        while time.monotonic() < deadline:
            status = tmux("display-message", "-p", "-t", "vimex-test", "#{pane_dead} #{pane_dead_status}").stdout.strip()
            if status.startswith("1 "):
                break
            time.sleep(0.05)
        assert status == "1 0", f"Vimex did not quit successfully in tmux: {status}"
        print(json.dumps({"passed": True, "checks": ["isolated-tmux", "markdown", "insert", "draft", "escape", "command-quit"]}))
    finally:
        tmux("kill-server", check=False)

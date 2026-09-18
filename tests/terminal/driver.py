"""Exercise the real executable in a PTY; no mocked renderer or input parser."""
import errno
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import tempfile

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
scenario = sys.argv[1] if len(sys.argv) > 1 else "demo"
temporary = tempfile.TemporaryDirectory(prefix="vimex-terminal-")
trace = os.path.join(temporary.name, "trace.jsonl")
config = os.path.join(temporary.name, "config.json")
with open(config, "w") as file:
    json.dump({"codexExecutable": os.path.join(root, "tests/terminal/fixtures/app-server.ts")}, file)
arguments = ["--demo"] if scenario in ("demo", "signal") else ["--config", config, "--cwd", temporary.name]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
process = subprocess.Popen([shutil.which("bun"), "run", "apps/tui/src/main.tsx", *arguments], cwd=root,
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                           env={**os.environ, "TERM": "xterm-256color", "NO_COLOR": "0", "HERDR_ENV": "0", "XDG_STATE_HOME": temporary.name, "VIMEX_TEST_TRACE": trace})
os.close(slave)
output = bytearray()

def pump(timeout=0.05):
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
            output.extend(data)
            return bool(data)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
    return True

def wait_for(value, start=0, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if value in output[start:]:
            return
        if not pump() and process.poll() is not None:
            break
    raise AssertionError(f"Missing terminal output {value!r}; tail={bytes(output[-1600:])!r}")

def send(value):
    offset = len(output)
    os.write(master, value)
    return offset

try:
    wait_for(b"NORMAL")
    assert b"\x1b[?1049h" in output, "alternate screen not entered"
    wait_for(b"Welcome to Vimex" if scenario in ("demo", "signal") else b"Terminal contract")
    if scenario == "save-failure":
        state_path = os.path.join(temporary.name, "vimex")
        if os.path.isdir(state_path):
            os.rename(state_path, state_path + "-saved")
        with open(state_path, "w") as file:
            file.write("Deliberate fixture: state directory became a regular file")
    offset = send(b"i")
    wait_for(b"INSERT", offset)
    offset = send(b"terminal integration draft")
    wait_for(b"terminal integration draft", offset)
    if scenario == "server":
        send(b"\r")
        wait_for(b"approval")
    offset = send(b"\x1b")
    wait_for(b"NORMAL", offset)
    if scenario == "server":
        offset = send(b":")
        wait_for(b"COMMAND", offset)
        send(b"approve")
        time.sleep(0.1)
        send(b"\r")
        wait_for(b"Verified")
    if scenario == "signal":
        process.send_signal(signal.SIGTERM)
    else:
        offset = send(b":")
        wait_for(b"COMMAND", offset)
        send(b"q")
        time.sleep(0.1)
        send(b"\r")
    end = time.monotonic() + 8
    while process.poll() is None and time.monotonic() < end:
        pump()
    if process.poll() is None:
        raise AssertionError("Command :q did not terminate Vimex")
    while pump(0):
        if not select.select([master], [], [], 0)[0]:
            break
    expected_exit = 1 if scenario == "save-failure" else 0
    assert process.returncode == expected_exit, f"exit code {process.returncode}, expected {expected_exit}"
    assert b"\x1b[?1049l" in output, "alternate screen not restored"
    assert b"\x1b[?25h" in output, "cursor not restored"
    if scenario == "server":
        with open(trace) as file:
            requests = [json.loads(line) for line in file]
        assert any(r.get("method") == "turn/start" for r in requests), "turn never submitted"
        assert any(r.get("id") == 77 and r.get("result", {}).get("decision") == "accept" for r in requests), "approval response never reached app server"
    print(json.dumps({"passed": True, "bytes": len(output), "checks": ["alternate-screen", "markdown", "insert", "draft", "escape", "command", "quit", "terminal-restoration"]}))
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
    temporary.cleanup()

"""Actual Vimex PTYs and fixture Codex/Rex protocols, never a live conversation."""
import errno, fcntl, json, os, pathlib, pty, select, signal, struct, subprocess, sys, tempfile, termios, time

root = pathlib.Path(__file__).resolve().parents[2]
launcher = [str(pathlib.Path(sys.argv[1]).resolve())] if len(sys.argv) > 1 else ["bun", "run", str(root / "apps/cli/src/main.ts")]
with tempfile.TemporaryDirectory(prefix="vimex-rex-restore-") as temporary:
    base = pathlib.Path(temporary)
    trace = base / "trace.jsonl"
    config = base / "config.json"
    config.write_text(json.dumps({"codexExecutable": str(root / "tests/terminal/fixtures/side-app-server.ts")}))
    bindir = base / "bin"
    bindir.mkdir()
    (bindir / "rex").symlink_to(root / "tests/terminal/fixtures/rex-identity.ts")
    environment = {**os.environ, "TERM": "xterm-256color", "HERDR_ENV": "0", "XDG_CONFIG_HOME": temporary,
                   "XDG_STATE_HOME": temporary, "VIMEX_TEST_TRACE": str(trace), "REX_SERVER": "unix:///vimex-fixture/server.sock",
                   "REX_SESSION": "session:fixture", "PATH": str(bindir) + os.pathsep + os.environ["PATH"]}
    environment.pop("VIMEX_REX_CHECKED", None)
    children = []

    def calls():
        return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []

    def checkpoint(block):
        for file in (base / "vimex" / "panes").glob("*.json"):
            value = json.loads(file.read_text())
            if value["identity"]["block"] == block:
                return value["checkpoint"]
        return None

    class Terminal:
        def __init__(self, block, arguments):
            self.block = block
            self.master, slave = pty.openpty()
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
            self.output = bytearray()
            self.child = subprocess.Popen([*launcher, *arguments], cwd=temporary,
                                          stdin=slave, stdout=slave, stderr=slave,
                                          preexec_fn=lambda: (os.setsid(), fcntl.ioctl(slave, termios.TIOCSCTTY, 0)),
                                          env={**environment, "REX_BLOCK": block})
            os.close(slave)
            children.append(self)

        def pump(self, seconds=.05):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([self.master], [], [], min(.02, max(0, end - time.monotonic())))[0]:
                    try:
                        data = os.read(self.master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            return
                        raise
                    if not data:
                        return
                    self.output.extend(data)

        def wait(self, predicate, label):
            deadline = time.monotonic() + 15
            while not predicate():
                exited = self.child.poll() is not None
                if exited and predicate():
                    return
                if exited or time.monotonic() > deadline:
                    raise AssertionError(label + ": " + repr(bytes(self.output[:1100])) + " ... " + repr(bytes(self.output[-800:])))
                self.pump()

        def ready(self):
            self.wait(lambda: b"NORMAL" in self.output and checkpoint(self.block) is not None, "TUI did not start")
            self.pump(.4)

        def quit(self):
            os.write(self.master, b"\x1b")
            self.pump(.15)
            os.write(self.master, b":quit\r")
            self.wait(lambda: self.child.poll() is not None, "TUI did not quit")
            assert self.child.returncode == 0

    try:
        first = Terminal("block:first", ["resume", "side-main", "--config", str(config), "--cwd", temporary])
        first.ready()
        os.write(first.master, b"iprivate restored draft")
        first.pump(.4)
        os.write(first.master, b"\x1b")
        first.wait(lambda: checkpoint(first.block)["machines"]["local"]["threads"]["side-main"]["draft"] == "private restored draft", "Draft was not checkpointed")

        # Same conversation, separate live pane: drafts must remain independent.
        other = Terminal("block:other", ["resume", "side-main", "--config", str(config), "--cwd", temporary])
        other.ready()
        assert checkpoint(other.block)["machines"]["local"]["threads"]["side-main"]["draft"] == ""
        other.quit()
        assert checkpoint(other.block)["active"] is False

        # Signal shutdown preserves desired-open state; process restart rehydrates exact thread.
        first.child.send_signal(signal.SIGTERM)
        first.wait(lambda: first.child.poll() is not None, "Signal did not stop TUI")
        assert first.child.returncode == 0
        assert checkpoint(first.block)["active"] is True
        restored = Terminal("block:first", ["rex", "resume-pane"])
        restored.ready()
        assert checkpoint(restored.block)["target"]["thread"] == "side-main"
        assert checkpoint(restored.block)["machines"]["local"]["threads"]["side-main"]["draft"] == "private restored draft"
        restored.quit()
        assert checkpoint(restored.block)["active"] is False
        count = len(calls())
        inactive = Terminal("block:first", ["rex", "resume-pane"])
        inactive.wait(lambda: inactive.child.poll() is not None, "Inactive pane relaunched")
        assert inactive.child.returncode == 0 and len(calls()) == count
        history = calls()
        assert sum(call.get("method") == "thread/resume" for call in history) == 3
        assert not any(call.get("method") in ("thread/start", "turn/start", "turn/steer", "thread/fork") for call in history)
    finally:
        for terminal in children:
            if terminal.child.poll() is None:
                os.killpg(terminal.child.pid, signal.SIGTERM)
                try:
                    terminal.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(terminal.child.pid, signal.SIGKILL)
                    terminal.child.wait()
            os.close(terminal.master)
print(json.dumps({"passed": True, "checks": ["independent same-thread drafts", "signal restart", "exact resume", "explicit quit", "no mutation replay"]}))

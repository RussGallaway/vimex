"""Opt-in real Codex + real OpenTUI acceptance driver.

This is deliberately excluded from `bun test`. It resumes known disposable live
threads, creates one read-only streaming turn in a temporary cwd, and drives the
actual alternate-screen application through a PTY.
"""
from __future__ import annotations

import base64
import codecs
import errno
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte

from frame_capture import save_frame

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE_THREAD = "01a0b1f7-e354-7743-938f-2a16c40e934a"
FORK_THREAD = "01a0b1fa-cd31-7f11-b465-275ed3d0c21c"
STREAM_DONE = "VIMEX_STREAM_DONE_7F31"

if os.environ.get("VIMEX_LIVE_ACCEPTANCE") != "1":
    raise SystemExit("Refusing live Codex validation without VIMEX_LIVE_ACCEPTANCE=1")

temporary = tempfile.TemporaryDirectory(prefix="vimex-live-terminal-")
temp = pathlib.Path(temporary.name)
state_home = temp / "state"
config_home = temp / "config"
herdr_config = temp / "herdr-plugin"
stream_cwd = temp / "read-only-stream"
url_capture = temp / "opened-url.txt"
for directory in (state_home, config_home, herdr_config, stream_cwd):
    directory.mkdir(parents=True, exist_ok=True)

url_action = {
    "openUrl": {
        "command": [
            sys.executable,
            "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
            str(url_capture),
            "{url}",
        ]
    }
}
(herdr_config / "external-actions.json").write_text(json.dumps(url_action))

pbpaste = shutil.which("pbpaste")
pbcopy = shutil.which("pbcopy")
host_clipboard_before = subprocess.run([pbpaste], stdout=subprocess.PIPE, check=True).stdout if pbpaste and pbcopy else None

master, slave = pty.openpty()
screen = pyte.Screen(120, 34)
terminal = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder("utf-8")("replace")


def resize(rows: int, columns: int) -> None:
    screen.resize(lines=rows, columns=columns)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


resize(34, 120)
environment = {
    **os.environ,
    "TERM": "xterm-256color",
    "NO_COLOR": "",
    "COLORTERM": "truecolor",
    "HERDR_ENV": "0",
    "HERDR_PLUGIN_CONFIG_DIR": str(herdr_config),
    "XDG_STATE_HOME": str(state_home),
    "XDG_CONFIG_HOME": str(config_home),
}
process = subprocess.Popen(
    [shutil.which("bun") or "bun", "run", "apps/tui/src/main.tsx", "--thread", SOURCE_THREAD, "--cwd", str(stream_cwd)],
    cwd=ROOT,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    env=environment,
)
os.close(slave)
output = bytearray()
checks: list[str] = []
frame_count = 0


def checkpoint(stage: str) -> None:
    global frame_count
    frame_count += 1
    save_frame(screen, pathlib.Path("/tmp/vimex-live-validation/frames"), f"{frame_count:02d}-{stage}")


def pump(timeout: float = 0.05) -> bool:
    if not select.select([master], [], [], timeout)[0]:
        return True
    try:
        chunk = os.read(master, 65536)
        output.extend(chunk)
        terminal.feed(decoder.decode(chunk))
        return bool(chunk)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise


def wait_for(value: bytes, start: int = 0, seconds: float = 12) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if len(output) > start and value.decode("utf-8") in "\n".join(screen.display):
            return
        if not pump() and process.poll() is not None:
            break
    raise AssertionError(f"Missing fresh rendered terminal text {value!r}; screen={chr(10).join(screen.display)!r}")


def settle(seconds: float = 0.15) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not pump(min(0.03, max(0, deadline - time.monotonic()))):
            break


def send(value: bytes, pause: float = 0.15) -> int:
    offset = len(output)
    os.write(master, value)
    settle(pause)
    return offset


def wait_absent(value: bytes, start: int, seconds: float = 12) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if len(output) > start and value.decode("utf-8") not in "\n".join(screen.display):
            return
        if not pump() and process.poll() is not None:
            break
    raise AssertionError(f"Rendered terminal text did not disappear: {value!r}")


def escape() -> int:
    # Legacy terminals distinguish Escape from Alt by an ambiguity timeout.
    # Never concatenate it with the next command or focus chord.
    offset = send(b"\x1b", pause=0.2)
    wait_for(b"NORMAL", offset)
    return offset


def insert() -> None:
    offset = send(b"i")
    wait_for(b"INSERT", offset)


def command(value: str, seconds: float = 12) -> int:
    offset = send(b":")
    wait_for(b"COMMAND", offset)
    send(value.encode())
    send(b"\r")
    settle(min(seconds, 0.5))
    return offset


def search(value: str) -> int:
    offset = send(b"/")
    wait_for(b"COMMAND", offset)
    send(value.encode())
    submitted = send(b"\r")
    wait_for(b"NORMAL", submitted)
    return offset


def switch_session(thread: str, expected: bytes, absent: bytes | None = None) -> None:
    offset = send(b"s")
    wait_for(b"Sessions", offset)
    typed = send(thread.encode())
    checkpoint("session-query-before-confirm")
    wait_for(thread.encode(), typed)
    # Require the ID in the actual search-input row, not in an unrelated title.
    assert any(re.search(r"/\s*" + re.escape(thread), line) for line in screen.display), "Session search input does not contain the requested thread ID"
    selected = send(b"\r")
    wait_absent(b"Sessions", selected, 30)
    wait_for(b"NORMAL", selected, 30)
    wait_for(expected, selected, 30)
    if absent is not None:
        wait_absent(absent, selected, 30)
    checkpoint("session-result-" + thread[-8:])


OSC52 = re.compile(rb"\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)")


def clipboard_after(start: int, previous: bytes | None, seconds: float = 8) -> bytes:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        matches = OSC52.findall(bytes(output[start:]))
        if matches:
            return base64.b64decode(matches[-1])
        if pbpaste:
            value = subprocess.run([pbpaste], stdout=subprocess.PIPE, check=True).stdout
            if value != previous:
                return value
        pump()
    raise AssertionError("Clipboard write was not observable through OSC 52 or the host clipboard")


try:
    wait_for(b"NORMAL", seconds=30)
    assert b"\x1b[?1049h" in output, "alternate screen not entered"
    wait_for(b"VIMEX_LIVE_OK", seconds=30)
    wait_for(b"OpenTUI", seconds=30)
    checks += ["real-thread-resume", "markdown-rendered", "alternate-screen"]
    checkpoint("initial")

    # Select the resumed transcript, resize while Visual mode remains active,
    # then capture both rendered text and original Markdown source.
    # Reconstruct the same full logical transcript range for both copy modes.
    # Searching a fixture marker can match the user prompt before its answer.
    send(b"G")
    visual = send(b"Vgg")
    wait_for(b"VISUAL", visual)
    wait_for(b"selected", visual)
    resized = len(output)
    resize(22, 72)
    os.killpg(process.pid, signal.SIGWINCH)
    wait_for(b"VISUAL", resized)
    wait_for(b"selected", resized)
    checkpoint("visual-selection-resized")
    plain_start = send(b"y")
    plain = clipboard_after(plain_start, host_clipboard_before)
    resized = len(output)
    resize(34, 120)
    os.killpg(process.pid, signal.SIGWINCH)
    wait_for(b"NORMAL", resized)
    send(b"G")
    visual = send(b"Vgg")
    wait_for(b"VISUAL", visual)
    wait_for(b"selected", visual)
    source_start = send(b"Y")
    source = clipboard_after(source_start, plain)
    checkpoint("plain-and-source-copied")
    assert b"OpenTUI" in plain and b"OpenTUI" in source
    assert plain != source and (b"[OpenTUI]" in source or b"](https://opentui.com" in source)
    checks += ["visual-selection-survives-resize", "copy-plain", "copy-markdown-source"]

    # Per-thread drafts must survive switching through the real session overlay.
    send(b"\x17j")
    insert()
    send(b"DRAFT_SOURCE_THREAD")
    escape()
    switch_session(FORK_THREAD, b"VIMEX_LIVE_OK", b"DRAFT_SOURCE_THREAD")
    send(b"\x17j")
    insert()
    send(b"DRAFT_FORK_THREAD")
    escape()
    switch_session(SOURCE_THREAD, b"DRAFT_SOURCE_THREAD", b"DRAFT_FORK_THREAD")
    switch_session(FORK_THREAD, b"DRAFT_FORK_THREAD", b"DRAFT_SOURCE_THREAD")
    checks += ["session-switch", "per-thread-drafts"]

    # Tool folds operate in place and preserve the transcript viewport.
    send(b"\x17k")
    search("/bin/zsh")
    opened_tool = send(b"zo")
    wait_for("▾".encode())
    folded = send(b"zc")
    wait_for("▸".encode(), folded)
    unfolded = send(b"zo")
    wait_for("▾".encode(), unfolded)
    checks.append("tool-fold-toggle")

    # A URL selected from the rendered transcript must pass through the shared
    # Herdr external-action configuration rather than launching a real browser.
    search("OpenTUI")
    opened = send(b"gx")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not url_capture.exists():
        pump()
    assert url_capture.read_text().rstrip("/") == "https://opentui.com"
    checks.append("viewport-url-herdr-action")

    # Confirm the fork dialog from a user-message boundary. The server-side fork
    # is read-only and starts no model turn.
    search("Read-only client integration validation")
    forked = send(b"f")
    wait_for(b"Fork session", forked)
    send(b"\r")
    time.sleep(0.5)
    overlay_probe = send(b"s")
    wait_for(b"Sessions", overlay_probe, 30)
    dismissed = escape()
    wait_absent(b"Sessions", dismissed)
    checks.append("fork-confirmation")

    # Start one fresh read-only model turn. Pin the transcript away from the
    # tail, edit the next draft while output streams, and require unseen output
    # before explicitly returning to the tail.
    command(f"new {stream_cwd}")
    wait_for(b"read-only-stream", seconds=30)
    send(b"\x17j")
    insert()
    prompt = (
        "Read-only terminal streaming validation. Do not use tools, inspect files, modify anything, "
        "access the network, create goals or tasks, or delegate. Reply directly in Markdown with the heading "
        "Vimex Streaming Validation, then exactly 60 numbered one-line observations about keyboard-driven "
        "terminal interfaces. End on its own line with " + STREAM_DONE + "."
    )
    send(prompt.encode())
    stream_start = send(b"\r")
    wait_for(b"working", stream_start, 30)
    checkpoint("streaming-started")
    escape()
    send(b"\x17k")
    send(b"gg")
    send(b"\x17j")
    insert()
    send(b"DRAFT_WHILE_STREAMING")
    escape()
    send(b"\x17k")
    wait_for(b"DRAFT_WHILE_STREAMING", stream_start)
    send(b"\x04\x15\x05\x19gg")  # ctrl-d/u/e/y, then pin at the first item
    wait_for(b" new", stream_start, 120)
    checkpoint("streaming-detached-with-draft")
    wait_for(b"idle", stream_start, 180)
    tail = send(b"G")
    wait_for(STREAM_DONE.encode(), tail, 30)
    checkpoint("streaming-complete-at-tail")
    checks += ["vim-scroll-motions", "fixed-composer-during-stream", "detached-viewport-unseen", "live-stream-complete"]

    quit_start = command("q")
    deadline = time.monotonic() + 12
    while process.poll() is None and time.monotonic() < deadline:
        pump()
    if process.poll() is None:
        raise AssertionError(":q did not terminate Vimex")
    while pump(0):
        if not select.select([master], [], [], 0)[0]:
            break
    assert process.returncode == 0
    assert b"\x1b[?1049l" in output[quit_start:], "alternate screen not restored"
    assert b"\x1b[?25h" in output[quit_start:], "cursor not restored"
    checks.append("quit-terminal-restoration")
    result = {"passed": True, "checks": checks, "terminal_bytes": len(output)}
    diagnostics = pathlib.Path("/tmp/vimex-live-validation")
    diagnostics.mkdir(parents=True, exist_ok=True)
    (diagnostics / "terminal-result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
except BaseException as error:
    try:
        checkpoint("failure")
    except Exception as capture_error:
        print(f"Frame capture failed: {capture_error}", file=sys.stderr)
    # Keep terminal diagnostics, but never serialize either host clipboard value
    # or the OSC 52 payload carrying a copied selection.
    diagnostics = pathlib.Path("/tmp/vimex-live-validation")
    diagnostics.mkdir(parents=True, exist_ok=True)
    sanitized = re.sub(rb"\x1b\]52;.*?(?:\x07|\x1b\\)", b"[OSC52 REDACTED]", bytes(output), flags=re.DOTALL)
    # A failure can interrupt an OSC sequence before its terminator arrives.
    sanitized = re.sub(rb"\x1b\]52;.*$", b"[INCOMPLETE OSC52 REDACTED]", sanitized, flags=re.DOTALL)
    (diagnostics / "terminal.ansi").write_bytes(sanitized)
    (diagnostics / "screen.txt").write_text("\n".join(screen.display))
    (diagnostics / "terminal-result.json").write_text(json.dumps({
        "passed": False, "checks": checks, "error": str(error), "terminal_bytes": len(output),
    }, indent=2))
    raise
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if host_clipboard_before is not None and pbcopy:
        subprocess.run([pbcopy], input=host_clipboard_before, check=False)
    os.close(master)
    temporary.cleanup()

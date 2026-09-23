"""Opt-in offline repeated Ctrl-U probe through the real Vimex process and PTY.

Run: python3 scripts/benchmark-transcript-navigation-pty.py
This measures PTY input/output timing. ANSI writes are not decoded into cells;
the result cannot establish painted-frame latency or cursor correctness.
"""

import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
REPEATS = int(os.environ.get("VIMEX_NAV_PTY_REPEATS", "6"))
INTERVAL_MS = int(os.environ.get("VIMEX_NAV_PTY_INTERVAL_MS", "33"))
if not 1 <= REPEATS <= 100 or not 1 <= INTERVAL_MS <= 1000:
    raise ValueError("Repeat count must be 1–100 and interval 1–1000 ms")

with tempfile.TemporaryDirectory(prefix="vimex-navigation-pty-") as temporary:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 100, 0, 0))
    process = subprocess.Popen(
        [shutil.which("bun"), "run", "apps/tui/src/main.tsx", "--demo"],
        cwd=ROOT,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        env={
            **os.environ,
            "TERM": "xterm-256color",
            "HERDR_ENV": "0",
            "XDG_CONFIG_HOME": temporary,
            "XDG_STATE_HOME": temporary,
        },
    )
    os.close(slave)
    output = bytearray()

    def pump(timeout=0.02):
        if not select.select([master], [], [], timeout)[0]:
            return b""
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return b""
            raise
        output.extend(data)
        return data

    def wait_for(marker, start=0, timeout=15):
        deadline = time.monotonic() + timeout
        while marker not in output[start:]:
            if time.monotonic() >= deadline or process.poll() is not None:
                raise AssertionError(
                    f"Offline demo did not emit {marker!r}; exit={process.poll()}, tail={bytes(output[-1200:])!r}"
                )
            pump()

    def send(value):
        start = len(output)
        os.write(master, value)
        return start

    try:
        wait_for(b"NORMAL")
        wait_for(b"demo")
        start = send(b"i")
        wait_for(b"INSERT", start)
        send(b"PTY repeat scrollback probe")
        send(b"\r")
        reply_deadline = time.monotonic() + 3
        while time.monotonic() < reply_deadline:
            pump()
        if b"Observation" not in output:
            raise AssertionError(
                f"Offline reply did not provide scrollback content; working={b'Working' in output}, draft={b'PTY repeat' in output}, tail={bytes(output[-400:])!r}"
            )
        start = send(b"\x1b")
        wait_for(b"NORMAL", start)
        # The generated offline answer spans several 100x20 viewports.
        send(b"gg")
        time.sleep(0.1)
        while pump(0):
            pass
        send(b"G")
        time.sleep(0.1)
        while pump(0):
            pass

        started = time.monotonic()
        dispatch_ms = []
        output_chunks = []
        next_key = 0
        deadline = started + (REPEATS - 1) * INTERVAL_MS / 1000 + 0.6
        while time.monotonic() < deadline:
            now = time.monotonic()
            if next_key < REPEATS and now >= started + next_key * INTERVAL_MS / 1000:
                send(b"\x15")  # Ctrl-U through the actual terminal input parser.
                dispatch_ms.append(round((time.monotonic() - started) * 1000, 3))
                next_key += 1
            data = pump(0.006)
            if data:
                output_chunks.append(
                    {
                        "atMs": round((time.monotonic() - started) * 1000, 3),
                        "bytes": len(data),
                        "keysDispatched": next_key,
                        "hash": hashlib.sha256(data).hexdigest()[:16],
                    }
                )
        if len(dispatch_ms) != REPEATS:
            raise AssertionError("The requested Ctrl-U inputs were not all sent")
        if not output_chunks:
            raise AssertionError("The terminal emitted no bytes after repeated Ctrl-U")
        print(
            json.dumps(
                {
                    "benchmark": "offline-demo-real-pty-navigation",
                    "status": "diagnostic",
                    "qualification": "Real PTY and offline demo; output chunks include differential ANSI writes and are not decoded paints or an independent destination oracle.",
                    "viewport": {"width": 100, "height": 20},
                    "requestedIntervalMs": INTERVAL_MS,
                    "dispatchMs": dispatch_ms,
                    "actualDispatchIntervalsMs": [
                        round(dispatch_ms[index] - dispatch_ms[index - 1], 3)
                        for index in range(1, len(dispatch_ms))
                    ],
                    "outputChunks": output_chunks,
                    "firstOutputMs": output_chunks[0]["atMs"],
                    "totalOutputBytes": sum(chunk["bytes"] for chunk in output_chunks),
                    "demoObservationMarkers": output.count(b"Observation"),
                }
            )
        )
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        os.close(master)

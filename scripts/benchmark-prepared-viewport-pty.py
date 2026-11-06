"""Credential-free prepared viewport PTY probe; requires pyte, no live thread.

Run: python3 scripts/benchmark-prepared-viewport-pty.py
Reconstructed terminal cells are not physical-emulator or human UX acceptance.
"""
import codecs
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import pyte

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT, BODY = 80, 20, 18
UP, DOWN = 60, 40
INTERVAL = 0.033
output = Path(os.environ.get("VIMEX_PREPARED_ARTIFACTS", "/tmp/vimex-prepared-viewport"))
output.mkdir(parents=True, exist_ok=True)


def run(name, detail_delay, blocking):
    screen = pyte.Screen(WIDTH, HEIGHT)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
    trace_path = output / (name + ".jsonl")
    trace_path.write_text("")
    with tempfile.TemporaryDirectory(prefix="vimex-prepared-") as home:
        process = subprocess.Popen(
            [shutil.which("bun"), "scripts/prepared-viewport-experiment.ts"], cwd=ROOT,
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
            env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor",
                 "HERDR_ENV": "0", "XDG_CONFIG_HOME": home, "XDG_STATE_HOME": home,
                 "VIMEX_PREPARED_TRACE": str(trace_path),
                 "VIMEX_PREPARED_DETAIL_DELAY_MS": str(detail_delay),
                 "VIMEX_PREPARED_BLOCK_MS": str(blocking)},
        )
        os.close(slave)
        chunks = []
        def pump(seconds=0.01):
            until = time.monotonic() + seconds
            while time.monotonic() < until:
                if not select.select([master], [], [], min(0.004, max(0, until-time.monotonic())))[0]:
                    continue
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not data:
                    return
                stream.feed(decoder.decode(data))
                chunks.append(time.monotonic())

        pattern = re.compile(r"PV a=(\d+) r=(\d+) p=(\d+) top=(-?\d+):(-?\d+) (\w+) (\w+)")
        def status():
            match = pattern.search(screen.display[-1])
            if not match:
                return None
            a, r, p, block, row, detail, state = match.groups()
            return dict(accepted=int(a), resolved=int(r), pending=int(p), top=int(block)*12+int(row), detail=detail, state=state)

        def wait_for(predicate, timeout=10):
            until = time.monotonic()+timeout
            while not predicate():
                if time.monotonic()>until or process.poll() is not None:
                    raise AssertionError(f"{name}: timeout/exit {process.poll()}\n"+"\n".join(screen.display))
                pump()

        def assert_cells(top):
            for offset in range(BODY):
                global_row = top+offset
                block, row = divmod(global_row, 12)
                expected = f"value_{block:03}_{row:02} = {global_row}  # prepared viewport"
                assert screen.display[offset].rstrip() == expected, (name, offset, expected, screen.display[offset])
            assert (screen.cursor.x, screen.cursor.y) == (0, 0), (name, screen.cursor)

        try:
            wait_for(lambda: status() and status()["state"] == "ready")
            assert_cells(120*12)
            initial = status()
            # Selection uses the domain model; clipboard is deliberately untouched.
            os.write(master, b"v")
            pump(0.02)
            start = time.monotonic()
            dispatch = []
            observations = []
            sequence = [b"\x15"] * UP + [b"\x04"] * DOWN
            for index, key in enumerate(sequence):
                target = start + index*INTERVAL
                while time.monotonic()<target:
                    pump(min(0.004, target-time.monotonic()))
                os.write(master, key)
                dispatch.append((time.monotonic()-start)*1000)
                pump(0.004)
                state = status()
                if state:
                    observations.append({"atMs": (time.monotonic()-start)*1000, **state,
                                         "blank": not any(line.strip() for line in screen.display[:BODY])})
            wait_for(lambda: status() and status()["resolved"] == UP+DOWN and status()["pending"] == 0)
            settle_ms = (time.monotonic()-start)*1000
            expected = 120*12 + (DOWN-UP)*(BODY//2)
            assert status()["top"] == expected, (name,status(),expected)
            assert_cells(expected)
            before_detail = list(screen.display[:BODY])
            wait_for(lambda: status() and status()["detail"] == "rich")
            pump(0.3)
            assert list(screen.display[:BODY]) == before_detail, name+": detail shifted visible text"
            assert_cells(expected)
            assert not any(frame["blank"] for frame in observations), name+": blank observed viewport"
            highlight_colors = sorted({screen.buffer[y][x].fg for y in range(BODY) for x in range(WIDTH) if screen.buffer[y][x].data.strip()})
            assert len(highlight_colors)>1, (name,"no visible syntax decoration",highlight_colors)
            os.write(master,b"y")
            pump(0.05)
            final = status()
            (output/(name+"-final.txt")).write_text("\n".join(screen.display))
            os.write(master,b"q")
            until = time.monotonic()+5
            while process.poll() is None and time.monotonic()<until:
                pump()
            if process.poll() is None:
                raise AssertionError(name+": process did not exit")
            assert process.returncode == 0, (name,"nonzero exit",process.returncode)
            events = [json.loads(line) for line in trace_path.read_text().splitlines()]
            keys = [e for e in events if e["kind"] == "key"]
            assert len(keys) == len(sequence) and all(e["accepted"] for e in keys)
            # Independent source-row oracle at every renderer completion. A
            # partially resolved command may be anywhere along its nine rows.
            frames = [e for e in events if e["kind"] == "frame" and e.get("top")]
            for frame in frames:
                resolved = frame["resolved"]
                exact = 120*12 + (max(0, resolved-UP)-min(resolved, UP))*(BODY//2)
                next_delta = (-1 if resolved<UP else 1)*(BODY//2) if resolved<len(sequence) and frame["pending"] else 0
                actual = frame["top"]["blockIndex"]*12+frame["top"]["row"]
                assert min(exact,exact+next_delta)<=actual<=max(exact,exact+next_delta), (name,"out-of-order frame",frame,exact)
            copies = [e for e in events if e["kind"] == "copy"]
            # Inclusive character selection: full prior blocks plus first char of start block.
            lines = [f"value_{b:03}_{r:02} = {b*12+r}  # prepared viewport" for b in range(expected//12,120) for r in range(12)]
            assert copies and copies[-1]["text"] == "\n".join(lines)+"\nv", (name,"copy mismatch",copies[-1] if copies else None)
            return {"name":name,"detailDelayMs":detail_delay,"blockingMs":blocking,
                    "initial":initial,"final":final,"dispatchMs":dispatch,"observations":observations,
                    "settledMs":settle_ms,"keyAcceptedMs":[e["atMs"] for e in keys],
                    "prepareMs":[e["durationMs"] for e in events if e["kind"]=="prepare"],
                    "detailEvents":sum(e["kind"]=="detail" for e in events),
                    "validatedRendererFrames":len(frames),
                    "visibleSyntaxColors":highlight_colors,
                    "copyCharacters":len(copies[-1]["text"]),"cache":events[-1]["cache"]}
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                until = time.monotonic()+2
                while process.poll() is None and time.monotonic()<until:
                    pump()
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            os.close(master)


results = [run("delayed-detail", 400, 0), run("immediate-detail", 0, 0), run("blocking-control", 0, 80)]
record = {"kind":"reconstructed-pty-prepared-viewport", "qualification":"Standalone native viewport, not production Vimex or physical emulator acceptance. ASCII fixed-row hold/reverse/release fixture; real CodeRenderable detail and synchronous negative control. Source-copy validated without host clipboard; selection overlay not exercised here.",
          "terminal":"xterm-256color", "dimensions":[WIDTH,HEIGHT], "cadenceMs":INTERVAL*1000,
          "up":UP,"down":DOWN,"results":results}
(output/"summary.json").write_text(json.dumps(record,indent=2)+"\n")
print(json.dumps({"artifactDirectory":str(output),"results":[{k:r[k] for k in ("name","final","settledMs","detailEvents","copyCharacters","cache")} for r in results]},indent=2))

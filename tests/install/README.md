# Installed executable acceptance

Run these commands against an unpacked or installed release executable:

```sh
bun tests/install/cli-smoke.ts /absolute/path/to/vimex
python3 tests/install/resume-smoke.py /absolute/path/to/vimex
VIMEX_TEST_BINARY=/absolute/path/to/vimex python3 tests/terminal/visual-driver.py
```

The scripts use disposable working/config/state directories outside the repository. CLI smoke verifies help, version, invalid arguments, and doctor without terminal initialization; doctor invokes only a fake Codex version probe. Resume smoke uses a JSONL fixture and a real PTY to verify explicit ID, latest, and picker routing without creating threads or submitting messages. It needs only Python's standard library. The visual driver requires `tests/terminal/requirements-live.txt` and reconstructs PTY frames under `/tmp/vimex-visual-e2e`.

Without a binary argument, resume smoke launches the source CLI. The source variant runs in the normal integration suite. These tests never invoke a real Codex runtime or change user configuration.

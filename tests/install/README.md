# Installed executable acceptance

Run the complete local release gate with `bun run check:release`. It builds, packages, verifies the checksum, and runs the probes below against an extracted native archive outside the checkout. Use Bun 1.3.6 and Python 3.12 with `tests/terminal/requirements-live.txt` installed. See [release validation](../../docs/releasing.md#local-release-validation) for virtual environment setup.

Temporary artifacts are removed after success and retained after failure. `bun run check:release --outdir dist` retains the archive, metadata, and reconstructed frames in `dist/frames/`. The same command runs on the Release workflow's four native targets.

Run these commands against an unpacked or installed release executable:

```sh
bun tests/install/cli-smoke.ts /absolute/path/to/vimex
python3 tests/install/resume-smoke.py /absolute/path/to/vimex
VIMEX_TEST_BINARY=/absolute/path/to/vimex python3 tests/terminal/visual-driver.py
```

The scripts use disposable working/config/state directories outside the repository. CLI smoke verifies help, version, invalid arguments, and doctor without terminal initialization; doctor invokes only a fake Codex version probe. Resume smoke uses a JSONL fixture and a real PTY to verify explicit ID, latest, and picker routing without creating threads or submitting messages. It needs only Python's standard library. The visual driver requires `tests/terminal/requirements-live.txt` and reconstructs PTY frames under `/tmp/vimex-visual-e2e`, or `VIMEX_TEST_ARTIFACTS_DIR` when supplied.

Without a binary argument, resume smoke launches the source CLI. The source variant runs in the normal integration suite. These tests never invoke a real Codex runtime or change user configuration.

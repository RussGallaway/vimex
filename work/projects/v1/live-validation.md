# Live validation

Status: **partial; full live terminal acceptance is not established**.

## Opt-in driver

`tests/terminal/live-driver.py` drives the real OpenTUI application in a Unix PTY and is intentionally excluded from default tests. It requires explicit opt-in:

```sh
python3 -m venv /tmp/vimex-live-venv
/tmp/vimex-live-venv/bin/pip install -r tests/terminal/requirements-live.txt
VIMEX_LIVE_ACCEPTANCE=1 /tmp/vimex-live-venv/bin/python tests/terminal/live-driver.py
```

The driver uses isolated XDG state and config directories and a temporary cwd. It resumes disposable thread `01a0b1f7-e354-7743-938f-2a16c40e934a` and its fork `01a0b1fa-cd31-7f11-b465-275ed3d0c21c`. It preserves and restores the host clipboard without logging its contents, and redirects Herdr URL actions to a temporary capture file instead of opening a browser.

The authorized live smoke run passed these checks:

- Full-screen entry and terminal restoration on `:q`.
- Real history resume with Markdown and link rendering.
- Visual selection across a resize, with distinct plain-text and Markdown-source copies.
- Session switching and independent per-thread drafts.
- Tool fold close/open behavior.
- Transcript URL opening through the configured Herdr external action.
- Fork confirmation from a user-message boundary.
- Vim line, half-page, and page-adjacent navigation.
- One constrained read-only live prompt, a detached viewport with unseen output, and composer editing while the response streams.

## Evidence obtained

- A direct read-only adapter resume of the existing source thread succeeded and hydrated 10 events after the stable/experimental capability fix.
- A dedicated Herdr plugin pane launched the real Vimex TUI and reported `idle`, `connection=connected`, the live Codex thread id, model, reasoning effort, cwd, and pending approvals. The validation pane and temporary plugin link were removed afterward.
- The live driver parses successfully and does not participate in `bun test`.
- The complete offline check passes 214 tests with 962 assertions and four frame snapshots, including four real-PTY scenarios and an isolated tmux smoke test. TypeScript and dependency-boundary checks pass.

## Authorization and current run

The user explicitly approved the live test after the initial automatic approval review rejection. The repaired driver completed all 16 smoke checks, including real streaming and terminal restoration. Intermediate runs exposed differential-render assertions, Escape timing, and fuzzy matching of an absent UUID to unrelated sessions. Complete UUIDs now resume exactly, and session/draft switching was verified live.

Artifacts: `/tmp/vimex-live-validation/frames/` contains reconstructed PTY PNGs, text, and cell geometry. `/tmp/vimex-live-acceptance.log` records the successful run. These are terminal-frame reconstructions, not native Ghostty screenshots.

This smoke run still does not prove every acceptance criterion: it does not resolve a real approval, exercise a real-server handled failure, prove all cursor/fold/anchor restoration invariants, or verify the complete Herdr lifecycle matrix. Fork confirmation was exercised, but independent new-thread identity/boundary assertions remain to be strengthened.

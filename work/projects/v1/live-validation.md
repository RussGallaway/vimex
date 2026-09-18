# Live validation

Status: **partial; full live terminal acceptance is not established**.

## Opt-in driver

`tests/terminal/live-driver.py` drives the real OpenTUI application in a Unix PTY and is intentionally excluded from default tests. It requires explicit opt-in:

```sh
VIMEX_LIVE_ACCEPTANCE=1 python3 tests/terminal/live-driver.py
```

The driver uses isolated XDG state and config directories and a temporary cwd. It resumes disposable thread `01a0b1f7-e354-7743-938f-2a16c40e934a` and its fork `01a0b1fa-cd31-7f11-b465-275ed3d0c21c`. It preserves and restores the host clipboard without logging its contents, and redirects Herdr URL actions to a temporary capture file instead of opening a browser.

Planned assertions cover:

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
- The complete offline check passes 158 tests with 549 assertions, including four real-PTY scenarios. TypeScript and dependency-boundary checks pass.

## Outstanding authorization

The automated approval reviewer rejected execution of the PTY driver because it would access live threads, inspect and restore the host clipboard, and create real session/fork/turn side effects. The driver was not retried. Full acceptance remains pending explicit user approval for that live run.

# TUI testing and visual evidence

## Reference approach

OpenCode's terminal tests use Bun and OpenTUI's in-memory renderer, including fixed-width character snapshots and direct scroll geometry assertions. Its browser application's Playwright screenshots are a separate test surface; they do not establish terminal coverage.

Sources inspected at OpenCode commit `b02acc1e30ef55f7f181fec8d2f241d26f022683`:

- [Terminal tool wrapping snapshots and scroll assertions](https://github.com/anomalyco/opencode/blob/b02acc1e30ef55f7f181fec8d2f241d26f022683/packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx)
- [Terminal lifecycle tests](https://github.com/anomalyco/opencode/blob/b02acc1e30ef55f7f181fec8d2f241d26f022683/packages/tui/test/app-lifecycle.test.tsx)
- [Browser Playwright configuration](https://github.com/anomalyco/opencode/blob/b02acc1e30ef55f7f181fec8d2f241d26f022683/packages/app/playwright.config.ts)
- [Browser timeline stability tests](https://github.com/anomalyco/opencode/blob/b02acc1e30ef55f7f181fec8d2f241d26f022683/packages/app/e2e/regression/session-timeline-context-resize.spec.ts)

## Vimex verification layers

1. Pure-domain tests establish logical cursor, selection, folding, and viewport state.
2. OpenTUI component tests exercise actual native renderables and keyboard handling. Fixed-size frames and geometry assertions detect layout regressions that substring assertions miss.
3. Disposable PTY tests launch the real executable and exercise terminal escape sequences against deterministic JSONL fixtures.
4. Opt-in live tests run against Codex with isolated local state and disposable threads. These establish integration behavior that fake-server tests cannot prove.

The live driver reconstructs terminal cells with pyte. Rendered-frame PNGs are captures of that PTY screen state, not operating-system screenshots of Ghostty or Herdr. They omit emulator-specific font shaping and window chrome. Native Ghostty screenshot access was rejected by the Computer Use tool, so native emulator appearance remains unverified.

## Assertion discipline

- Inspect the reconstructed screen, not just raw ANSI substrings: incremental redraws may emit only changed characters.
- Verify that mode transitions and overlay dismissal actually occur before sending the next dependent action.
- Confirm the session query is visible before submitting it; a visible session list alone is insufficient.
- Check semantic cursor/anchor state and geometry independently of a visually plausible final frame.
- Save intermediate frames, not just the terminal state after a failure.
- Preserve failure diagnostics with clipboard escape payloads redacted. Do not record the user's original clipboard.
- Do not count a passing smoke driver as proof of all specification acceptance criteria.

## Herdr visual-mode reference

Reviewed `herdrdev/herdr` commit `da6bcd5969779bfe0396bcf89a8025d4375d611e`. Its [copy-mode key and motion implementation](https://github.com/herdrdev/herdr/blob/da6bcd5969779bfe0396bcf89a8025d4375d611e/src/client/shell/copy_mode.rs) inspired semantic word/WORD motions and rapid input regression coverage. Herdr serializes pending motions before copy and guards stale results. Its [copy regressions](https://github.com/herdrdev/herdr/blob/da6bcd5969779bfe0396bcf89a8025d4375d611e/src/client/shell/tests/copy.rs) explicitly clear selection on resize; Vimex deliberately preserves semantic selections across reflow instead.

## Running visual probes

Install `tests/terminal/requirements-live.txt` into an isolated Python environment as described in [live validation](live-validation.md). Run `python tests/terminal/visual-driver.py` with that interpreter for a disposable offline demo probe. It captures frames under `/tmp/vimex-visual-e2e/`, including mode isolation, resized layout, session search, the bottom command bar, and the working heartbeat. This does not use live Codex or the clipboard.

The user-authorized live driver separately passed history, resize/copy, session/draft switching, tool folds, URL action, fork confirmation, streaming/drafting, and terminal restoration. Full acceptance remains governed by [the acceptance matrix](acceptance-matrix.md).

Latest integrated checkpoint: 304 tests, 1,590 assertions, four frame snapshots, typecheck and boundaries pass. The offline PTY driver passes eight checks including chained `:model`/model-ID/thinking-level completion and same-batch next-draft preservation. Captures are reconstructed PTY frames in `/tmp/vimex-visual-e2e`; the model completion frame is `07-model-effort-completion.png`. This does not replace the remaining real-server and Herdr acceptance gates.

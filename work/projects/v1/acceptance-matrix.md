# V1 acceptance evidence

The numbered requirements below come from [the specification](spec.md). **V1 completion is not established.** Offline tests, a real adapter round trip, and a partial Herdr exercise are useful evidence, but they do not prove the specification's end-to-end real-app-server workflows.

| # | Required behavior | Evidence obtained | Remaining verification |
| --- | --- | --- | --- |
| 1 | Start, submit, stream Markdown and tools | Real read-only Codex tool turn through the adapter; real-renderer JSONL fixture submission, approval, and completion | Observe the full workflow in the real TUI against Codex |
| 2 | Scroll back, type during streaming, retain logical position | Application test preserves draft focus and semantic anchor under deltas; renderer derives anchors from actual rows | Combined real-server streaming/typing/scrolling run |
| 3 | `G` returns to the tail and follows | Pure tail-attachment tests and renderer key routing | Real-server follow behavior after detachment |
| 4 | Resize a Visual selection and copy rendered text | Grapheme selection tests; native Markdown layout/reflow mapping tests | Real terminal resize and clipboard result |
| 5 | Copy canonical Markdown for that selection | Source-envelope tests for links, fences, tables, emphasis, multiline code, and references | Paired real-terminal plain/source copy |
| 6 | Navigate to URL and open with `gx` | URL motions/indexing and application-port tests; keyboard URL picker renderer test | Real transcript `gx` through configured external action |
| 7 | Fold/unfold tools and edits without cursor movement | Pure fold/cursor invariants, configured-fold renderer tests, responsive diff renderer tests | Live tool/edit folding and retained viewport |
| 8 | Switch sessions and restore draft, cursor, folds, anchor | Application round-trip tests, serialized view tests, native composer switch tests | Combined real-session reading-state round trip |
| 9 | Fork from previous message and enter the fork | Real adapter fork; application boundary/confirmation tests; renderer confirmation callback | Actual TUI confirmation and entry into fork |
| 10 | Resolve approval entirely by keyboard | Real executable + deterministic JSONL server approval through `:approve` | Actual Codex approval, including decision acknowledgment |
| 11 | Normal and handled-failure exit restores terminal | Real-PTY normal quit, SIGTERM, persistence failure; React fatal-boundary and cleanup-order tests | Real-server handled-failure terminal exercise |
| 12 | Herdr thread and lifecycle reporting | Dedicated real Herdr pane launch/idle metadata; lifecycle adapter tests | Real working/blocked/idle transitions, clipboard and restoration matrix |

The opt-in driver and existing live evidence are described in [live-validation.md](live-validation.md). Its execution remains pending explicit user authorization following automatic approval review rejection. No failed or unexecuted live check is counted as passed.

Additional release evidence includes dependency-boundary checks, unit/integration/contract tests, Unicode editing tests, performance regressions, runtime restart/stale-response tests, and a disposable tmux demo smoke test. See [terminal support](../../../docs/terminal-support.md) for precise environment coverage. Hosted CI configuration is not evidence that the remote jobs have run successfully.

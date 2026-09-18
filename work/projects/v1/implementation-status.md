# Vimex v1 Implementation Status

This is an implementation checkpoint, not a declaration that v1 acceptance is complete. The specification remains authoritative.

## Implemented and under validation

- Full-screen OpenTUI React shell, fixed composer, Markdown rendering, four Vim modes, anchored navigation, semantic selection and copying, search, URL selection, folds, and responsive diffs.
- Codex JSONL transport, versioned schema mapping, stable history resume, streaming, start/switch/fork, steering, interruption, approvals, structured questions, model and reasoning settings, and controlled restart.
- Searchable sessions, confirmed forks through a completed turn, parent/child navigation, per-thread drafts and reading state, and recovered outbox entries requiring explicit retry.
- Vim composer operators, named command overrides, command history/completion, theme and syntax preferences, and reduced-color configuration.
- Enter sends by default; Shift+Enter inserts a newline. Alt+Enter is not a default shortcut.
- Application-owned ports and behavior under domain/application owners, feature-owned UI files, and concrete adapters selected in the executable composition root.
- Herdr pane launch manifest, lifecycle/session/metadata reporting, and configured external URL actions.
- Unit, integration, adapter contract, renderer, and real-PTY tests. Default terminal tests cover demo navigation, JSONL approvals/streaming, Enter/Shift+Enter submission, SIGTERM, persistence failure restoration, and an isolated tmux session when tmux is available.

## Checkpoint validation

The latest completed full checkpoint passed TypeScript, dependency boundaries, and 343 tests with 1,844 assertions and four frame snapshots. Four diagnostic timing tests are opt-in; the two Shift-Tab cases pass when explicitly enabled, alongside the prior scrolling diagnostics. The eight-check offline real-PTY driver also passes. See [review rounds](review-rounds.md) for the separate commits, scrolling measurements, and remaining initial-history settlement cost. `git diff --check` passes; the prior frozen-lockfile installation check remains applicable because dependencies did not change.

A formatted Markdown projection that previously took about 5.6 seconds for 58 KB took about 7 ms after replacing repeated Unicode prefix segmentation with indexed boundary lookup. This measures projection only; it is not an end-to-end rendering benchmark.

Real Codex adapter validation completed a read-only tool turn, resumed it, restarted the app-server connection, resumed again, and forked the completed turn. A dedicated Herdr pane launched Vimex and reported its live thread and lifecycle metadata. See [live validation](live-validation.md) for the separate terminal acceptance evidence and outstanding acceptance gaps.

Runtime/navigation race regressions, long-list keyboard visibility, fatal React cleanup, and draft-save warning repairs are complete and covered by the checkpoint checks.

The follow-up audit repaired Unicode cursor conversion, Visual-mode selection cleanup, explicit open-fold persistence, queued submission after fast turn completion, and stale-event transcript projection. Renderer tests cover Markdown/table mapping after reflow and measurement-cache invalidation. A local 400-line fixture averaged approximately 0.08 ms per warm layout measurement, compared with approximately 31 ms for the previous measurement plus serialization; this is not a whole-application frame benchmark. Native Markdown geometry depends on the pinned OpenTUI version and must be revalidated on upgrades.

See the [acceptance matrix](acceptance-matrix.md) for evidence and gaps against each specification criterion.

Additional TUI hardening now covers Normal/Visual native-input isolation, Ctrl-J/K focus, semantic word motions, exact-ID session resume, a separate composer panel and bottom command/status strip, responsive session/header layout, and explicit activity indicators. See [TUI testing](tui-testing.md) for source research and visual evidence.

## Remaining acceptance work
- Exercise the real terminal acceptance matrix, including resized Markdown copying, streaming anchors, thread view restoration, forks, and URLs. The authorized live smoke driver passed 16 checks; remaining gaps are recorded in the acceptance matrix.
- Establish live keyboard approval resolution and handled-failure terminal restoration evidence; offline tests alone do not satisfy the specification’s real-app-server acceptance requirement.
- Observe Linux and macOS CI results; local success does not establish the remote matrix.

## Structural correction

The initial implementation accumulated domain behavior in package entry points, application orchestration in the CLI, and a broad `backend.ts` interface. These diverged from `topology.md`. The correction places behavior under its domain/application owner, organizes UI files by feature, and separates volatile adapters. Boundary checks guard against implementation barrels, reversed domain/application imports, UI adapter selection, production testkit imports, and generic UI component directories.

Do not change the specification to make unfinished implementation appear complete.

## Current refinements

- Bottom-bar command autocomplete and composer slash commands share completion rendering and vocabulary. Model commands support a selector or direct exact-ID arguments, with paginated catalog discovery.
- Up/Down focus the transcript/composer; menu arrows retain selection behavior. Session menus support Normal j/k and Insert search.
- Transcript yanks populate the composer register with normalized line delimiters while clipboard text remains unchanged.
- Composer footer spacing has been reduced per visual feedback, retaining the blank separator above status.
- Real-PTY immediate-next-draft preservation now passes the eight-check offline driver; evidence is recorded in `/tmp/vimex-visual-e2e/result.json`.
- `/skills` discovery and structured draft attachments remain required follow-up work under the agreed command UX.

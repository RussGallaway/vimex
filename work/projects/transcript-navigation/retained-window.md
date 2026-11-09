# Retained transcript window

Current status (2026-11-09): promoted to default behavior following Russ's positive local feedback. The corresponding environment flag now disables the feature only when set to `0`. The opt-in instructions and results below describe the historical experiment.

Status: opt-in experiment, 2026-11-06. Replaces the rolling-preparation experiment after local feedback that middle-transcript movement remains slow.

## Change

Use one bounded mounted neighborhood in the head, middle, and tail. Keep its endpoints while the viewport remains comfortably inside it; replenish when approaching its inner boundary. This follows the range-retention approach in [CodeMirror](https://github.com/codemirror/view/blob/main/src/viewstate.ts) and [Virtuoso](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/src/sizeRangeSystem.ts).

The planner uses the existing edge budgets: 900 indexed rows plus 48 lookahead rows, capped at 300 blocks. Required visible/overscan blocks and whole-block rounding can exceed those limits. The middle splits the area above and below the viewport; at an edge the space extends inward. The inner guard is at most the ordinary overscan margin, reduced when block limits leave a smaller neighborhood. A range that becomes more than twice the target row budget through measurement refinement is replanned.

Stable block keys resolve retained endpoints through the current height index. New content revisions still update normally. Thread/canonical-generation and geometry-generation/width/style changes disallow reuse of the prior window. Distant jumps materialize their destination. Current viewport anchors, cursors, selections, and canonical history remain authoritative.

Removed the rolling-growth scheduler, its timers and release listener, the runtime preparation state and growth API, and its superseded tests. There is no background expansion or stop-only mode. This is one planner policy, not a second renderer or another preparation queue.

```sh
VIMEX_NAV_REPEAT_CONTROL=1 VIMEX_NAV_PREPARED_PAINT=1 VIMEX_NAV_RETAINED_WINDOW=1 bun run start
```

Omit `VIMEX_NAV_RETAINED_WINDOW` for the control. `VIMEX_NAV_ROLLING_PREPARATION` and its mode flag no longer enable anything.

## Evidence

Eight domain tests cover stable interior movements, replenishment and immediate reversal, equal head/middle/tail budgets, distant jumps, reveal destinations, measured-height corrections, streaming retention, and layout reset. Two connected tests verify actual native-root retention through four Ctrl-E movements with either focus surface, preserving the draft and initial cursor/viewport/selection. The existing 39-test scroll-continuity suite also passes with retained windows and repeat control enabled, including cold reversals, streaming, and dense-paint comparisons.

The exploratory held-input benchmark used 1,000 Markdown items, initial item 512, 120 repeats at 33 ms, an independent sender, and repeat control/prepared paint enabled. Ordinary middle navigation previously recorded 61 window changes and 677 preparation passes. The retained-window run recorded **one window change and 561 passes**, with no blank frames.

This confirms reduced window churn, **not a latency improvement**. The retained run's movement-paint gaps were p95 48.6 ms, maximum 135.7 ms, versus 33.1 / 44.5 ms in the ordinary run. It stopped at item 488/offset 866 versus 480/5571 under repeat coalescing, so these are not equivalent completed traversals. These are single headless runs, not physical-terminal UX acceptance.

The main remaining cost is movement through an already-mounted range: native Markdown readiness, measurement/publication, and cursor/anchor settlement still run. Mounting more content does not certify completed offscreen Markdown transformation. Local testing should distinguish movement inside a settled range from the moment it is replenished. If ordinary movement is still slow, optimize that path before adding more preparation machinery.

Validation: `bun run check` passed on the final source changes, including formatting, types, dependency boundaries, generated documentation, and all default tests. The 12 repeat-control connected tests additionally pass with retained windows enabled. `git diff --check` passed. No physical-terminal UX acceptance is claimed.

## Local feedback

Russ reports that held Ctrl-U/D now feels immediate within the current neighborhood, pauses for an estimated 100 ms when the next area loads, then becomes immediate again. He strongly prefers this behavior and approved committing the checkpoint. This is user-reported local UX evidence; the pause duration is an estimate, not an instrumented measurement. It supports the retained-window direction despite the inconclusive headless latency comparison above.

Navigation becomes noticeably slower while a message is printing into the transcript. Investigate streaming invalidation and contention separately from neighborhood replenishment. Preserve the successful stationary-history behavior while reviewing composition, module boundaries, and scheduling; avoid adding another preparation system before identifying the work that streaming introduces.

# Transcript review and repair rounds

The two rounds review correctness, terminal responsiveness, and ownership boundaries. Each round is committed before the next begins. Local benchmarks measure the named operation, not end-to-end input latency or a scalability guarantee.

## Round 1

Baseline: `273037e` (with adapter checkpoint `5c78691`).

Findings and repairs:

- Scrolling used cursor movement as a viewport update, coupling reading position to Visual selection. An application `viewport.anchor` command now preserves cursor and selection.
- App owned geometry measurement, restoration, and cache comparison. These responsibilities now live in `transcript/use-transcript-layout.ts`, using the measurement cache's identity instead of serializing every logical point.
- Cursor-only changes rebuilt estimated wrapping and selected text unnecessarily. Geometry dependencies and memoized transcript inputs now track actual content changes.
- Counted scrolling dispatched the same domain transition repeatedly after already multiplying the native scroll distance. One transition now describes one scroll action.
- Wheel movement could silently reattach native sticky scrolling at the bottom. Native sticky state now follows semantic tail attachment; vertical wheel input detaches immediately and retains focus.
- Explicit tail attachment could be undone by generic cursor visibility handling. Tail entry now jumps to the bottom and bypasses that conflicting reconciliation.
- Reading anchors lost a blank row at the viewport edge. Restoration now preserves the measured anchor's actual screen-row offset.
- Combining marks caused incorrect display widths for accented base characters.
- Vertical navigation, word motions, adjacent search, and scroll-only geometry did unnecessary whole-transcript work. Indexed lookups and immutable geometry reuse bound repeated navigation work more closely to the requested operation.
- Message navigation treated tool/reasoning blocks as messages; projection now preserves node kind for accurate message boundaries.

Validation: full check passed 317 tests, 1,685 assertions, four snapshots, TypeScript, and dependency boundaries. Reproducible `bun scripts/benchmark-transcript-scroll.tsx` measured 135,389 characters: warm scroll geometry 0.114 ms, anchor lookup 0.249 ms (including initial index construction), native frame 0.136 ms averaged over 12 jumps; baseline geometry was 67.17 ms. Remaining v1 acceptance gates remain in `acceptance-matrix.md`.

## Round 2

Pending the verified round-1 commit. Reviewers will rotate ownership and examine the committed result for correctness, cache invalidation, lifecycle, and design regressions.

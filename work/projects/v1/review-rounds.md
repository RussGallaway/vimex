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

Baseline: `7cb7c4e` (round 1 committed before review 2). Three parallel reviewers rotated responsibility across geometry, full-App rendering, and pure transcript behavior; the final diff review extended the second round.

Findings and repairs:

- Culled offscreen Markdown retained old screen coordinates, invalidating the entire geometry cache on scroll. Fingerprints now use native parent-local coordinates; scroll translation reuses logical geometry.
- Real asynchronous Markdown/table reflow now reapplies detached reading anchors. Focus changes alone do not reveal an offscreen cursor or move the reading position.
- Cursor movement within very large messages reveals the measured cell, rather than attempting to reveal the whole message.
- Stable transcript rows are memoized; status-only item updates reuse text projections. Invalid/stale anchors and nonfinite navigation counts are normalized or rejected at the semantic boundary.
- Estimated row endpoints, folded rows, and Unicode terminal-cell widths now agree more closely with native geometry.
- Tool calls start collapsed; file-change diffs start expanded. Explicit fold choices are preserved.
- File-change metadata retains per-file paths, actions, rename targets, and exact patches. Cards show accurate hunk counts, use native syntax-language identifiers, and explain absent textual patches. See [OpenCode diff review](diff-review.md) for inspected source and the separate review-screen direction.
- Split diffs require dedicated canonical-source-to-column mapping, rather than scanning interleaved screen text. Regression coverage includes native diff geometry.

Performance evidence: the reproducible 135,389-character single-item benchmark measured warm geometry 0.120 ms, anchor lookup 0.216 ms, and native frame 0.139 ms. The opt-in full-App benchmark with 100 historical Markdown items measured warm Ctrl-U/D settling at 23–25 ms, versus roughly 610 ms before the culling repair. First input immediately after injecting an unsettled 100-item history still took about 1.3 seconds in the synthetic benchmark. Initial native content settlement remains an optimization target; these results do not establish cold-load instant scrolling. Changed Markdown still requires full projection parsing (54.6 KB with one-character deltas averaged about 8.5 ms in a separate pure projection diagnostic).

Validation: eight offline real-PTY interaction checks pass, with reconstructed terminal screenshots in `/tmp/vimex-visual-e2e`. Timing fixtures are opt-in (`VIMEX_PROFILE_TUI=1`), not machine-dependent CI gates. Final full-suite counts are recorded in `implementation-status.md`.

## Shift-Tab responsiveness follow-up

The user identified toggle-all folding as the slow interaction. A full-App diagnostic with 100 settled Markdown messages and one 100-line output measured roughly 669–676 ms to expand and 1,160–1,172 ms to collapse on the committed geometry baseline. After repair, the same fixture measured approximately 69–76 ms to expand and 66–68 ms to collapse. A 20-output variant measured 94–99 ms to expand and 85–86 ms to collapse. These are local diagnostic timings, not CI thresholds or guarantees for arbitrary output sizes.

Repairs:

- Fold-all updates only foldable transcript nodes, clears obsolete message fold flags, and preserves state identity when already applied.
- Geometry caches each item independently. Changing a fold translates unchanged sibling geometry rather than remapping all historical Markdown. Value-based native fingerprints retain content/reflow/resize invalidation without depending on replaced native object identities.
- Estimated wrapping stops once authoritative native geometry exists.
- Collapsed fallback mapping calculated the complete Unicode grapheme list inside every offset-loop iteration. Moving that calculation outside the loop removes quadratic collapse work; a bounded property-read test guards against recurrence.
- Current-fold Vim shortcuts use the same foldability/surface guard as Tab and now work in transcript Visual mode without clearing selection.
- Semantic navigation no longer emits redundant unfold actions for already-open targets. The broader hidden-content word-motion policy remains a separate UX decision.

Validation: TypeScript, dependency boundaries, 343 tests, 1,844 assertions, four snapshots, and eight offline real-PTY checks pass. Four timing diagnostics are opt-in. Fold geometry tests verify unchanged-item reuse, translated positions, immutable prior layouts, and bounded collapsed mapping work. Existing resize and same-size asynchronous Markdown mutation regressions remain green.

Run `VIMEX_PROFILE_TUI=1 bun test packages/ui-opentui-react/src/transcript/wheel-interaction.test.tsx -t 'Shift-Tab folding'` to reproduce the 1-output and 20-output diagnostics. The additional UX candidates are recorded in `roadmap.md`.

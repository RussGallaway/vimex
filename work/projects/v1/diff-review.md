# File-change diff review

Reference: OpenCode commit `5a8335857b0ebec44ef6aa1d52b339cf25c329ca`, inspected locally on 2026-09-17.

## What OpenCode does

- [Inline Edit and ApplyPatch](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/routes/session/index.tsx#L2390) use OpenTUI's native diff renderer, syntax highlighting, line numbers, and separate addition/deletion backgrounds. Inline diffs switch to split above 120 columns unless configured as stacked. ApplyPatch renders each file separately, with created/deleted/moved/patched labels; deletions get a line-count summary.
- [Dedicated diff viewer](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/feature-plugins/system/diff-viewer.tsx) separates working-tree, branch, and last-turn sources. It offers a file tree, per-file counts, reviewed markers, single-file display, file/hunk navigation, and persistent split/unified preference. Its responsive decision uses the remaining patch-pane width, allowing for the file tree.
- [Edit approval](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/routes/session/permission.tsx#L22) shows the proposed patch using the same native diff presentation.
- [Viewer tests](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/test/cli/tui/diff-viewer.test.tsx) exercise actual terminal renderables, return-route preservation, hunk navigation, and correct source requests. These are useful patterns for our own integration tests.

## Vimex direction

The immediate implementation remains inline transcript diffs: per-file patches expanded by default (tool calls start collapsed), compact summaries when manually folded, action/path/rename labels, hunk-derived addition/deletion counts, syntax highlighting, and responsive split/unified display. Preserve the exact server patch independently of presentation. A file with no textual patch should say so rather than imply that nothing changed.

Vimex has a stronger transcript interaction requirement: Normal-mode cursor movement, Visual selection, and yanking must remain correct across both diff columns, wrapped lines, multiple files, folding, and resize. Screen order and unified-patch source order differ in split view. Generic text matching is insufficient; map diff lines to the actual rendered columns. Decorative headers and line numbers must not contaminate source copying.

A dedicated review screen is a follow-up, not part of the current inline repair checkpoint. Expose the same review capability through `/diff` and `:diff`, with explicit source arguments when supported. Keep the source visible: a historical agent edit is different from the current working tree. Do not infer current Git state from historical tool calls or reconstruct patches from colored terminal cells.

Suggested review interaction: `j/k`, Ctrl-U/D, Vim `]c`/`[c` for changed hunks, existing `{`/`}` for block navigation, and Escape returning to the previous transcript anchor. A file tree is useful on wide terminals; narrow layouts should retain a file picker and unified patch. Selection and copying remain first-class. Stage, revert, and filesystem mutation are separate capabilities and are not implied by opening a review screen.

## Ownership

- Codex adapter maps server file-change metadata and exact patches into conversation items.
- Conversation owns immutable edit records; transcript owns folds, logical cursor, selection, and copying.
- OpenTUI presentation owns colors, per-file rendering, and measured coordinates.
- Any future working-tree review uses a separate source port rather than giving the transcript filesystem or Git responsibilities.

## Validation requirements

Cover mixed-language multi-file edits, adds/deletes/renames, absent textual patches, valid hunk counts (excluding file headers), stale metadata during patch updates, split/unified resize, and copying across rendered diff lines. Retain exact raw patches for source-oriented operations. Large expanded patches must also participate in scrolling benchmarks.

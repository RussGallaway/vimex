# One-row discrepancy: source mapping investigation

Date: 2026-11-05. Starting checkpoint: `c07a471` on `feat/transcript-prepared-navigation`.

## Observed path

The previous long comparison ended on the same logical source cursor but at different native viewport rows. Ordered tracing now records every resolved intent, with a bounded detailed-event window. This separates queued input from the moment its native preparation, anchor restoration, and cursor resolution finish. It does not certify that asynchronous source mapping cannot subsequently change.

The [initial ordered comparison](evidence/2026-11-05-row-first-differences.json) captures all 600 resolved movements with no dropped records. An early horizontal discrepancy converges before the next intent. The [focused trace](evidence/2026-11-05-row-refinement.json) repeatedly shows the consequential transition around intents 483–484 (repeated-route keys 183–184):

- The baseline divides the seven-row upward movement into six plus one and chooses logical offset 52 at screen column 11.
- The budget variant moves seven rows at once and chooses logical offset 45 at column 12.
- Before the next intent, the budget variant receives a same-height Markdown geometry update that moves offset 45 to column 50.
- The following movement therefore starts from different columns and ends at different viewport rows, 4 versus 5.

These offsets index the projected plain text, not raw Markdown syntax: `The transcript stays readable while reviewing older work.` Offset 45 is the space after “reviewing”; offset 52 is the “w” in “work”. Tracing changes scheduling and can change later divergence, so this is a repeatable local transition, not a claim that every run has the same first divergent source point or final symptom.

The initial estimated-height fallback hypothesis is not demonstrated as the cause of this transition. Do not fix it by adjusting the final viewport one row.

## Reduced native evidence

A small native fixture renders that Markdown link while deliberately withholding the tree-sitter response. Before completion, the CodeRenderable contains raw Markdown, is highlighting, and has `drawUnstyledText=false`. The actual surface is blank, but Vimex's measurement still produces navigation points from that provisional buffer. After completion, rendered text appears and source points change despite an unchanged two-row height.

This distinguishes a genuinely provisional native map from a coordinate-extraction-only bug. Existing `line-info-change` observation notices the later update; the missing distinction is whether the earlier map was eligible to resolve input at all.

## Readiness constraints

OpenTUI 0.5.11 exposes `CodeRenderable.isHighlighting` and `highlightingDone`, but highlight work begins during `renderSelf`. Dirty content before that phase can report no active work and an already-resolved promise. Completed conversation status and unchanged block height are also insufficient: Markdown text leaves can use streaming previews and asynchronous chunk transforms inside a completed message.

The prototype must retain ordered input until required source mappings are usable. It must account for work not yet started, resume asynchronously, reject stale completion after content/style/window or intent changes, and avoid waiting for unrelated offscreen decoration. No fixed delay is a correctness certificate. Do not replace Markdown-owned highlight/chunk callbacks just to observe completion.

The [external follow-up](research.md#follow-up-correction-ordering-and-exact-placement) supports explicit geometry/native-commit/correction ordering, but does not establish causation for this native mapping defect.

## Status

The prototype observes genuine native CodeRenderable render calls; it delegates exactly once and restores the original method on teardown. A completed render without pending highlighting certifies the current content/transform identity. Promise completion requests a real render rather than marking a mapping ready by itself. Stale completions after content/style changes, destruction, or teardown cannot publish readiness. No scratch render touches the live hit grid.

The UI applies this check only to displayed leaves of completed Markdown blocks. It refreshes computed native placement before testing intersection, so a culled child's stale zero height cannot bypass the check. Offscreen siblings in large blocks are not awaited. Mounted observations survive warm revisits and are removed on destruction. Active streaming keeps its existing path; this prototype does not certify every streaming revision or every offscreen source point.

Queued motion retains its target while waiting. The next key cannot begin before the earlier active movement has resolved its cursor and anchor. Four held Ctrl-U inputs in the connected regression now resolve in accepted order and match a ready control at each source/native destination, including the actual painted character. Explicit `G` supersession and destruction before worker completion also pass. Four helper tests cover real-render delegation, hit testing, stale completion/cleanup, and a partially visible 80-paragraph root; existing destination and streaming tests pass.

Blocking is scoped to active row movement: an unrelated completed Markdown leaf must not prevent idle selection of already-ready compact tools. Readiness changes invalidate the owning map; an early native-scroll advance waits until preparation refreshes geometry. An additional connected lifecycle test waits for genuine worker completion and idle frames, verifies the origin's painted character, then checks native wheel movement followed by two Ctrl-U inputs against ready content. It avoids injecting user input reentrantly inside a render callback. This validates the lifecycle, not an isolated ablation of the refresh guard.

The [first post-prototype comparison](evidence/2026-11-05-readiness-comparison.json) matches all 400 resolved source/native destinations in the focused 200-up/200-down route. The original 300-up/300-down route still diverges later, at sequence 739 (the 139th downward movement): one run leaves a long Markdown block while the other remains inside it. This is not complete schedule equivalence. Subsequent tracing must follow active intent IDs, since readiness can cause movement 439 to resolve after more than 500 keys have already been dispatched; a dispatch-only detail filter can miss the relevant correction.

The [sequence-aware trace](evidence/2026-11-05-reversal-correction.json) captures the later transition. Both runs move seven rows from the same logical origin, then measure a Markdown fragment growing from one to 36 rows. The baseline changes its top spacer by 78 rows and the variant by 29 while native scroll stays fixed. The baseline then anchors the next edit block; the variant remains in Markdown. No cold-index fallback occurs.

This reveals a second publication owner: `App` cursor and selection callbacks call the measuring path with the runtime, allowing dirty geometry and a new window to publish outside navigation preparation. At sequence 739, publication occurs after paint while a movement's anchor is pending. Anchor recovery subsequently replaces a valid translated anchor with a point in the shifted window.

The repair introduces a placement reader that bypasses measurement and reads published frame geometry. Cursor/selection callbacks use it; it neither publishes heights nor consumes dirty measurement work. Anchor recovery retains an already-valid translated anchor and restores its intended screen row after reflow. A native regression injects zero, three, or nine rows of padding growth during a row step: all variants land on the same source position and painted command line at row 10. Removing only anchor preservation makes that regression land on different content, demonstrating that readonly consumers alone are insufficient. Two independent reader regressions verify that dirty work survives reads for later preparation and that translated cursor/selection endpoints match painted cells.

## Final paired result

The [combined-fix comparison](evidence/2026-11-05-corrected-long-route.json) repeats the original 10,000-item workload: 300 initial upward keys, tail reset, and 300 upward/300 downward keys. All 600 resolved movements now agree in source cursor, native cursor position, viewport anchor, and coherence flag across the two measurement schedules. No trace records were dropped. Every action's final semantic/native state agrees. Cold traversal and reversal cells are identical; tail reset differs only in the animated spinner. Both runs report zero blank frames and zero pending measurement backlog.

This closes the reproduced discrepancy, not arbitrary scheduling or latency acceptance. Both experimental flags remain off by default. Readiness may defer a cold movement until source mapping finishes, and repeated required-root placement checks add work. Active streaming and offscreen mappings remain outside the new readiness certificate. Prepared rows remain the architectural route to making exact preparation cheap and anticipatory.

The first full repository check found a streaming-detachment paint regression. A 38-to-36-block window change removed two old offscreen blocks without adding any new ones, but array-identity change armed the cold-preparation time budget. That let a four-key hot scroll batch paint after only three movements. Cold arming now distinguishes newly mounted block keys from pruning/content-only updates. Existing overload, continuation, and native-edge limits remain. The existing folded/expanded streaming paint oracle is strengthened with 16 ms of simulated elapsed time per native layout during detachment; no expected paint is relaxed.

The final-source long comparison passes after this adjustment with the same 600-of-600 agreement recorded above. The complete `bun run check` also passes, including formatting, types, dependency boundaries, generated documentation, and all default tests (local log: `/tmp/vimex-row-discrepancy-final-source-check.log`). Project links, retained JSON evidence, and `git diff --check` pass. Actual-terminal cold-navigation UX and the prepared-row architecture remain separate work.

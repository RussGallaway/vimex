# Prepared transcript navigation plan

Status: correctness repairs and standalone native text-row prototype implemented; prepared-row navigation integration pending. Work branch: `feat/transcript-prepared-navigation`.

Ordered traces reproduce disagreement at resolved input boundaries, and a 30-item native fixture isolates sensitivity to dividing one half-page motion into smaller steps. Per-input cursor target retention and native child placement preparation repair the reduced fixture and the eight-key long-transcript trace. See the [investigation record](geometry-investigation.md); this does not yet satisfy the general coherent-commit or terminal UX gates.

The [source mapping follow-up](source-mapping-investigation.md) repairs the reproduced one-row discrepancy: completed Markdown readiness, read-only cursor/selection geometry consumers, and preservation of a valid anchor through reflow make all 600 resolved movements agree in the original paired long-route diagnostic. Both experiment flags remain off by default. This is a correctness result, not a latency claim or proof for all scheduling patterns.

The [prepared text prototype](prepared-text-prototype.md) now prepares native plain/code rows without rich renderables and passes the supported mounted painted-cell matrix. It remains standalone: newline/EOF boundary policy differs from existing measurement, per-grapheme output is verbose, and a 13,000-grapheme preparation takes roughly 9–11 ms synchronously in the diagnostic run.

The [compact preparation follow-up](compact-preparation-prototype.md) adds lossless row/run storage, explicit bounded cache/queue work, and tested compatibility with current plain/code cursor addresses, including newline/EOF. Tabs with legacy/native width disagreement and nonzero first-line offsets remain unsupported. These components are standalone; cache budgets do not yet include navigation boundary preparation.

The [isolated prepared viewport](prepared-viewport-prototype.md) now includes compatibility/source-index preparation in its cache budget and passes a credential-free PTY hold/reverse/release fixture with delayed real highlighting. Its synchronous-blocking control still produces a backlog. This is not production or physical-terminal acceptance.

The [opt-in runtime geometry bridge](prepared-runtime-bridge.md) now uses prepared points through the existing production measurement/publication path for completed final command-output fragments. Connected tests preserve selection/copy/navigation and lifecycle tests cover stale work. Native painting and runtime point-record retention remain unchanged; no production speedup is claimed.

The [opt-in production painter](prepared-runtime-paint.md) now draws prepared visible rows for that subset while preserving original native source/layout and falling back for selection or incompatible states. Connected tests confirm actual prepared painting, navigation, resize, and keyboard/mouse copy. The cost probe shows no plain-text speedup; the flag stays off.

Next: investigate cold preparation, duplicate native/prepared layout, hot-path source checks/point materialization, and expensive rich-content reconciliation. Extend nonfinal-fragment newline policy and Markdown only with parity evidence. Retain delayed-mapping, supersession, and correction-order regressions as gates; do not reintroduce geometry publication from display consumers or treat a completed message/unchanged height as a ready map.

## Product outcome

Holding `Ctrl-U`/`Ctrl-D` should move predictably through cold history. Reversing should respond promptly. Releasing should stop on an exact, readable destination. Rich detail may arrive later, but must not shift text, move the cursor, or reinterpret accepted input.

Correctness and observable UX lead the work. Record input acceptance, useful movement, exact destination, detail completion, backlog, and memory separately. A next-changed-paint percentile is not a substitute for this experience.

## Existing foundation and constraints

- Keep the coordinate repair and held-navigation benchmark from the checkpoint.
- Leave both older experiment flags off for the initial baseline. Their records are controls, not proposed production settings.
- Preserve v1 screen-row motion, cursor-follow, source-copy, folds, detached reading, and streaming behavior.
- Transcript domain owns logical cursor, anchor, selection, and folds; Workbench retains presentation runtimes. The runtime may retain renderer-neutral row metadata. OpenTUI owns native cells and adapter-specific layout.
- Do not add a second canonical transcript or semantic cursor. Do not import OpenTUI into the transcript domain. No new package or process boundary is assumed.
- Keep scrollback uncapped by default. Any cache budget must evict derived data rather than silently discard canonical history.

## Proposed responsibility map

```text
canonical transcript + presentation inputs
                 |
      shared layout preparation
                 |
       revisioned row/source maps --------> ordered motion resolver
                 |                                  |
       visible row/cell fragments             semantic destination
                 |                                  |
                 +-------- coherent presentation ---+
                                   |
                           cheap viewport paint
                                   |
                      deferred decoration/refinement
```

This map is a proposed boundary, not a new store hierarchy. Native measurements can refine geometry, but their publication must coordinate geometry, spacers, placement, and anchor compensation. A coherent visible frame must not mix those revisions.

## Work slices and exit gates

### 1. Reproduce and trace geometry corrections

Next concrete action on the branch: instrument the first repeated-route keys around the known production-policy disagreement. Record accepted motion sequence, geometry revision, changed block heights, top/bottom spacers, pending row remainder, `scrollBy`/`scrollTo`, preferred screen row, and the frame that actually paints.

Use the 10k/300-key fixture and then minimize the failing transition. Compare fully resolved key boundaries; a paint with the same dispatched-key count need not have resolved the same input. Add a native-placement oracle for the minimized case instead of treating the control as automatically correct.

Exit: a deterministic explanation or reduced reproduction of how measurement batching changes the destination. Record which behavior satisfies the native screen-row contract. Capture a real-terminal cold traversal too; do not claim the broader reported hesitation is reproduced solely by the synthetic mismatch.

### 2. Coordinate geometry and viewport commits

Prototype a revisioned presentation operation that applies the following consistently before paint:

1. Accept a valid geometry batch against its content/layout generation.
2. Reconcile document extent, window, and spacer placement.
3. Compensate the stable logical anchor at its intended screen row.
4. Acknowledge the presented geometry revision before resolving dependent row movement.

The precise protocol follows slice 1 evidence. Distinguish first measurement, remeasurement, and geometry-neutral decoration. Preserve ordered keys and explicit navigation supersession. Reject stale preparation results without dropping valid motion intent.

Exit: batch size/timing and delayed measurements do not change final semantic/native placement for the same input in the reduced fixture. No blank frame, wrong-way movement, or post-release anchor jump. Do not freeze geometry for an entire hold if doing so makes cold destinations fictitiously exact.

### 3. Produce rows without rich renderables

Standalone prototype evidence is recorded in [prepared text rows](prepared-text-prototype.md). Whole-block native metadata comes from `logicalLineInfo`; grapheme widths are measured with the same text engine and verified against source-line spans. Painted-cell parity is established for the tested subset. Integration still requires boundary-policy parity and a compact bounded retention strategy.

Initial API inspection of the pinned OpenTUI 0.5.11 found public `TextBuffer` and `TextBufferView` APIs that can wrap text without React or Yoga. A first prototype can use `TextBuffer.create(renderer.widthMethod)`, `setText`, `setTabWidth`, and a view configured with the same wrap mode, width, first-line offset, and viewport. `lineInfo` and `getLineSources` are candidates for source mapping; `measureForDimensions` alone provides dimensions, not a navigation map. Dispose the view before its buffer after extracting compact data. Validate these APIs against mounted native text/code before adopting a contract. Native wrapping is still synchronous and needs bounded work.

Inspect reusable OpenTUI text-buffer/wrapping primitives and identify a narrow adapter contract for width-specific layout. Begin with completed plain text and code. Share layout rules with rendering rather than creating an approximate second engine.

Retain row breaks, source/grapheme mappings, cell widths, and height summaries independently of expensive native nodes. Key derived data by stable identity, content revision, width, layout-affecting style, fold state, and presentation variant. Distinguish layout-affecting changes from color-only decoration where the renderer permits it.

Exit: row count and source/cell positions match the native renderer for ASCII, Unicode/emoji, tabs, empty content, long lines, wrapping boundaries, and width changes. Measure preparation/startup/memory costs. A scalar estimated height is not sufficient for exact cursor motion.

### 4. Move a viewport over prepared rows

Prototype a cheap viewport/cell-fragment path driven by the prepared row map. Keep rich reconciliation downstream when possible. Deliberately delay rich results to verify movement and stopping; separately inject genuinely expensive synchronous work to test whether the shared event loop still blocks input/output.

Prepare ahead of travel within explicit memory/work limits, prioritizing the visible destination and a directional neighborhood. Reversal should reprioritize obsolete preparation, not collapse ordered up/down input into an unsafe net delta. Retain recent geometry after render eviction. Keep background work bounded after release; avoid an unlimited idle-drain cliff.

Exit: held movement, reversal, and release remain correct while rich results are delayed. Actual-terminal observation shows the intended experience. No claim of isolation if movement still waits for a synchronous rich layout pass.

### 5. Expand content and settle architecture

Extend only after parity to Markdown concealment, lists/headings, tables, split/unified diffs, folds, and streaming revisions. Large individual blocks need internal work limits, not just a cap on block count. Unsupported cases retain the correct existing path until they have a validated layout contract.

Exit: mixed-content real-terminal validation, independent destination assertions, bounded retained memory, acceptable startup/reflow costs, and full repository checks. Update normative architecture/implementation records only for accepted changes. Retire superseded experiment code deliberately.

## Validation matrix

| Axis        | Required evidence                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Travel      | Held up/down beyond the prepared region, immediate reversal, release, counted motions, `gg`/`G`, warm revisit     |
| Geometry    | First measurement, later resize, same-height placement change, width/style/fold changes, huge blocks              |
| Content     | Text/code first; then mixed Markdown, tables, commands, tool activity, and both diff layouts                      |
| Concurrency | Streaming while detached, stale preparation completion, thread/pane switch, explicit navigation supersession      |
| Schedule    | Different batch sizes, delayed rich results, delayed geometry results, new input during background work           |
| Correctness | Exact source cursor and native row, stable reading anchor, ordered semantics, no blank/wrong-way/stale frame      |
| Cost        | Actual key cadence, input-to-useful/exact paint, detail completion, backlog, preparation time, startup and memory |
| UX          | Real terminal with recorded dimensions/emulator/multiplexer; reader can orient, reverse, and stop reliably        |

Run focused native and domain regressions at their owning layers; run `bun run check`, `bun run boundaries` when boundaries/imports change, and `git diff --check` before integration. Do not write tests that merely restate a budget constant. Live-thread drivers remain outside routine validation unless explicitly authorized.

## Open decisions

- Can existing native text primitives expose exact layout without constructing the rich render tree, or does that require an upstream OpenTUI capability?
- What is the smallest coherent geometry-commit protocol that preserves half-page semantics?
- How much row metadata/cell content should survive eviction, and how should directional preparation be bounded?
- What honest display behavior is acceptable when even the row map is cold? Do not silently substitute estimated exactness.
- Is bounded same-thread work sufficient, or does measured input/output blocking justify a separate execution path? Decide from evidence, not from async architecture alone.

## Progress

- [x] Preserve research, local experiment outcomes, and baseline repair.
- [x] Agree on the architectural direction and isolated branch workflow.
- [ ] Slice 1: reduced correction-order reproduction and trace.
- [ ] Slice 2: coherent geometry/viewport commit prototype.
- [ ] Slice 3: standalone parity/cache and opt-in production geometry bridge complete for final command-output fragments; broader eligibility and compact runtime retention pending.
- [ ] Slice 4: isolated delayed-detail viewport and opt-in production command-output painter complete; broader rich-content decoupling, measured benefit, and physical-terminal UX acceptance pending.
- [ ] Slice 5: mixed-content expansion and integration decision.

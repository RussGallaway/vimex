# Transcript Windowing Dogfooding Guide

Status: active field guide. As of 2026-09-22, transcript scrollback and navigation quality gates further feature development. Stage 5 bounded-work acceptance remains useful evidence, but does not establish frame-by-frame visual continuity. See [the scrollback investigation](./transcript-scrollback-investigation.md).

## Purpose

Use Vimex to build Vimex and record transcript-windowing problems only when they are observed. This guide helps connect a visible symptom to the architectural boundary most worth inspecting, captures enough evidence to reproduce it, and prevents plausible-but-unobserved risks from turning into premature implementation work.

The governing rule is:

> Protect semantic correctness proactively; optimize and polish from reproduced evidence.

Windowing should change physical work, not observable transcript meaning. The dense/pass-through frame remains the correctness reference. A windowing-specific repair should begin only when at least one of these is true:

- normal dogfooding or a user report reproduces visible incorrect behavior;
- canonical meaning, copy output, selection, navigation, or persisted state can be corrupted;
- a deterministic fixture demonstrates history-sized native allocation or steady-state work;
- an existing acceptance gate fails;
- instrumentation shows an intended bounded path repeatedly selecting a dense fallback at realistic scale.

A theoretical edge case without one of those signals belongs in the symptom map, not the work queue.

## Fast capture

When something feels wrong, capture this before restarting if practical:

```text
Observed at:
Build/commit:
Terminal and dimensions:
Thread shape: short | long history | one oversized item | active stream
Presentation: main | side
Viewport: following | detached | reattaching
Action immediately before symptom:
Visible symptom:
Expected behavior:
Repeatable: always | sometimes | once
Resize, fold, search, selection, or stream involved:
Recovery: none | G/follow | resize | thread switch | restart
Artifact: screenshot | frame text | log | copied text | none
```

Prefer the smallest event-and-input sequence that still reproduces the behavior. Preserve copied text or semantic targets when the problem involves selection, search, URLs, or Markdown source; a screenshot alone cannot establish semantic correctness.

## Symptom-to-boundary map

The entries below are investigation starting points, not presumed causes.

| Observed UX symptom                                                        | First boundary to inspect                                                           | Useful comparison or evidence                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Reading position jumps during streaming                                    | detached anchor capture, displayed revision pinning, height correction              | logical anchor before/after; whether the viewport was actually detached                            |
| Reading position jumps after resize or Markdown settles                    | measured block-local geometry and anchor restoration                                | item ID, grapheme offset, preferred screen row, old/new width                                      |
| Blank gap, overlap, or impossible scroll extent                            | height index and top/window/bottom row conservation                                 | spacer rows, mounted block rows, total indexed rows                                                |
| Tail stops following or follows unexpectedly                               | semantic viewport state and follow/detach transition                                | `tail` versus `point` viewport before the triggering action                                        |
| `G` or explicit follow does not reveal the newest output atomically        | reattachment and latest displayed revision selection                                | canonical versus displayed revision and publication count                                          |
| Unseen count increments twice, misses output, or clears early              | detached unseen accumulator and damage coalescing                                   | distinct changed item IDs and repeated delta sequence                                              |
| Search, mark, jump, URL motion, or history restore lands incorrectly       | off-window target index, reveal routing, fold-aware settlement                      | logical target before planning; target materialized afterward                                      |
| Visual selection changes after scrolling or resize                         | logical selection endpoints and native clipping                                     | dense copy result versus windowed copy result                                                      |
| Rendered copy or Markdown-source copy is missing or duplicated             | canonical projection/source map and fragment ownership                              | exact copied bytes; fragment boundary near each endpoint                                           |
| Fold opens at the wrong location or moves the reader                       | fold damage, height replacement, anchor restoration                                 | measured height before/after; logical point retained                                               |
| Activity batch count changes while scrolling, or a child cannot be reached | complete activity membership, zero-height index entries, protected cursor/selection | compare the pass-through batch with the bounded window; reveal a middle child and return to follow |
| Duplicate or stale content flashes during movement                         | stable block keys, content revisions, stale native callbacks                        | mounted root IDs and revision accepted by measurement                                              |
| Main and side transcript disturb each other                                | per-presentation runtime, geometry, and visibility ownership                        | which runtime published; identity of the unaffected frame                                          |
| Hidden or maximized-away pane still consumes work                          | visibility suspension and scheduler cleanup                                         | mounted roots, listeners, measurement passes while hidden                                          |
| Input becomes slow only with long history                                  | dense fallback, complete-plan/index rebuild, or canonical ingress                   | operation counters at 100/1k/10k/100k with identical input                                         |
| Scrolling becomes slow while mounted count stays bounded                   | per-root render cost, native measurement, or oversized fragment                     | descendants and logical points per mounted root                                                    |
| One large command, Markdown response, or diff freezes the UI               | fragmentation eligibility and conservative root fallback                            | item kind/status/fold state, source size, fragment count                                           |
| Memory grows after repeated distant jumps                                  | departed-root pruning, geometry cache, parsed native resources                      | mounted/tracked/pruned roots and settled RSS trend                                                 |
| Short sessions feel worse than the dense implementation                    | estimate/measure/replan overhead and initial policy settlement                      | cold commits, measurement passes, and input latency on small fixtures                              |
| Empty items or turn activity appear in the wrong order                     | complete block chronology and source-less activity ownership                        | dense block sequence versus windowed block sequence                                                |

## Investigation order

Debug from meaning outward. This avoids treating a presentation symptom as a canonical-state defect or repairing native layout around an incorrect logical target.

```text
1. Canonical conversation
          |
2. Semantic TranscriptState
          |
3. Complete render-block plan
          |
4. Height index and planned window
          |
5. Runtime frame and block-local geometry
          |
6. React/OpenTUI mounted roots
          |
7. Terminal cells seen by the user
```

At each boundary ask:

1. Is the logical item, point, fold, selection, and viewport state correct?
2. Does the complete dense reference produce the expected result?
3. Is the selected window the smallest bounded set that contains the required target?
4. Are top spacer + mounted rows + bottom spacer equal to total rows?
5. Did measurement accept only current block keys and content revisions?
6. Did departed roots and pending work get released?

The first boundary where correct input becomes incorrect output owns the investigation.

## UX areas to watch while dogfooding

These workflows define the investigation matrix. Reproduce the reported failures first, then extend coverage around their causes. Further feature development waits for transcript navigation acceptance.

### Following and detachment

- Compose and edit while a response streams at the tail.
- Scroll upward during streaming and confirm the reading position remains stable.
- Observe unseen-output behavior across repeated deltas to one item and admission of new items.
- Reattach with `G` and confirm the newest revision appears as one coherent transition.

### Navigation outside the mounted window

- Use `gg`, `G`, search, marks, jumps, message motions, and URL motions across distant history.
- Fold or unfold a target before and after a distant reveal.
- Switch sessions and return to a restored logical viewport.

### Selection and copying

- Start and finish Visual selections in different windows.
- Resize while a selection is active.
- Compare rendered-text and Markdown-source copies around links, fenced code, emoji, tables, and fragment boundaries.

### Geometry and content shape

- Resize narrow and wide around wrapped Markdown and split diffs.
- Notice late table/Markdown settlement, empty items, source-less activity, and folded rows.
- Pay attention to one oversized item even when total thread history is short.

### Multiple presentations and lifecycle

- Open a side chat, move its viewport, and ensure the main transcript does not move or republish unnecessarily.
- Hide, maximize away, reveal, switch, and close presentations.
- Watch for stale cursor placement or selection after returning to a previously hidden pane.

## Known constraints that are not currently bugs

Do not reopen these solely because they are theoretically proportional to input size:

- cold construction and hydration may visit the complete semantic input;
- full-text search may scan the searched canonical text;
- copying a large selection is proportional to the output produced;
- conservative or ambiguous content may use the exact dense/full-rebuild fallback;
- complex Markdown, running items, folded items, and unsupported oversized roots are not promised universal fragmentation;
- windowing does not page canonical conversation history from the server or bound the semantic model's total memory;
- previous Stage 5 timing samples were diagnostic and operation counts established bounded work; the scrollback investigation additionally requires frame continuity and measured input latency, with hardware and terminal context recorded.

Investigate one of these only after a realistic reproduction violates UX expectations or a Stage 5 bounded-work invariant.

## Triage

Use the smallest severity that describes demonstrated impact:

| Severity    | Demonstrated impact                                                                           | Default response                                                     |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Semantic    | wrong copied text, lost state, wrong target, reordered content, or canonical corruption       | stop and repair before relying on the affected workflow              |
| Blocking    | crash, unrecoverable blank transcript, or ordinary input starvation                           | reproduce and repair promptly                                        |
| UX          | jump, flicker, stale frame, awkward settlement, or surprising follow behavior with a recovery | reproduce and block further feature work until navigation acceptance |
| Performance | measured work grows with history or one realistic item overwhelms the native tree             | add a deterministic scaling fixture before optimizing                |
| Observation | suspicious behavior seen once without adequate evidence                                       | retain the report; do not design from it yet                         |

## Observation log

Add concise entries here or link a dedicated issue when investigation becomes substantial.

| Date       | Build                                          | Symptom                                                       | Severity | Reproduction/artifact                                     | Suspected boundary                                   | Status        |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------- | -------- | --------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| 2026-09-22 | Working tree with prior scroll and brace fixes | User still reports flickering and buggy transcript scrollback | UX       | [Investigation](./transcript-scrollback-investigation.md) | Native paint, measurement, window and anchor handoff | Investigating |

When a finding is repaired, link the regression test and commit. Keep the original symptom wording so later reports can be recognized even if the underlying implementation changes.

## Hands-on checkpoint after prepaint preparation

Run the working tree with `bun run start` (or `bun run start --demo` for the offline fixture). An installed release does not automatically include these uncommitted changes.

While output is arriving, scroll backward with Ctrl-U/Ctrl-Y and the mouse, type a draft, navigate earlier tool blocks with `{`/`}`, then work back down and use `G`. Also try `gg` immediately followed by `G`, rapid reversals near both ends, and folded versus expanded tools.

The experience should remain one continuous transcript: no entry pause, transition banner, blank frame, content correction, or forced return to the tail. New output should preserve the reading anchor; `G` should resume following without losing the draft or changing folds. Correct navigation is the acceptance gate before further feature work.

Record the command/build, terminal dimensions, folded state, whether output was streaming, and the shortest failing key sequence. Distinguish wrong destination, visible correction, and delayed response. Headless frame tests are supporting evidence; this hands-on checkpoint remains unaccepted until actually exercised.

## Architectural references

- [Transcript runtime design](./transcript-runtime.md) defines semantic and presentation ownership.
- [Transcript windowing implementation](./transcript-windowing-implementation.md) records Stage 5 invariants, fallbacks, benchmarks, and accepted non-goals.
- [UX specification](./ux.md) remains authoritative for observable interaction behavior.
- [Live validation](./live-validation.md) records which real-terminal workflows have and have not been exercised.
- `packages/transcript/src/window.ts` owns complete blocks, fragmentation, logical target materialization, and pure window planning.
- `packages/transcript/src/height-index.ts` owns persistent row and item/block lookup.
- `packages/transcript/src/runtime.ts` owns per-presentation revision, damage, window, and geometry reconciliation.
- `packages/ui-opentui-react/src/transcript/use-transcript-layout.ts` owns the volatile bridge between semantic anchors and native placement.
- `packages/ui-opentui-react/src/transcript/rendered-layout.ts` owns mounted-root measurement, pruning, and native coordinate projection.

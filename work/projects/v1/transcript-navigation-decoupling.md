# Transcript navigation and rendering decoupling

Status: **partial prototype**, first implemented 2026-09-24. The [runtime design](./transcript-runtime.md), [architecture](./architecture.md), and [navigation benchmark](./transcript-navigation-benchmark.md) remain authoritative for the v1 interaction contract and earlier evidence.

## Implemented slice and limits

- `{` and `}` already resolve semantic destinations before native painting. Paragraph boundaries are now cached by immutable projection identity, and counted motions search those boundaries without rescanning each preceding paragraph. Streaming revisions produce new projections and invalidate the cache naturally.
- A cold `Ctrl-U`/`Ctrl-D` window transition can carry queued row intent across renderer frames after bounded native preparation. It yields only when the current runtime window, measured layout, and visible native content agree; hot mounted navigation retains its previous same-frame path. Ordered keys, cursor-follow behavior, and anchor restoration still use native measured geometry.
- The runtime can distinguish a destination's measured local point map from an estimated fallback. This **does not** certify the global document row: earlier historical block heights may still be estimates. A fallback can locate a window for materialization, while the visible native point determines final cursor placement.
- This is a first useful-paint improvement for cold transitions, not general paint-free navigation. The 400-item connected diagnostic's common eight-key burst was largely inside the hot window and showed no measured improvement. A 200-step boundary run produced readable intermediate frames with no blank frames or semantic reversal, but its first-final boundary paint remained 35.2 ms median and 70.9 ms p95 in that one run. The separate large expanded-history regression reaches the same final native oracle after intermediate paints. Broader latency and memory claims require repeated real-session traces.

## Goal and expected experience

Vim motions should remain responsive across long, dirty, mixed transcripts containing Markdown, commands, tool output, diffs, agent activity, folds, and oversized blocks. A key should be accepted promptly; the first useful view should appear promptly; and the final cursor and viewport should land at the exact destination required by the motion. These are **three distinct outcomes**, not one latency number.

The proposed approach separates navigation intent and lightweight position lookup from rich block rendering. It does not remove the need for exact geometry. In particular, `Ctrl-U`/`Ctrl-D` preserve screen-row behavior across variable-height blocks, so a cold destination cannot be called exact merely because a placeholder appeared quickly. Semantic block motions such as `{`/`}` are easier to resolve from block order and identities.

```text
Current cold path (conceptual)
key -> prepare geometry and mounted window -> resolve/paint destination

Proposed path (where sufficient geometry is cached)
key -> resolve exact destination -> publish position -> paint useful view
                                         \-> prepare richer visible fragments

Cold geometry gap
key -> record latest intent -> show honest progress/useful known content
                         -> prepare required geometry -> publish exact destination
```

Repeated input should supersede preparation for locations the reader has already passed. A stale preparation result must never move the viewport backward or overwrite a newer navigation intent. Warm recent scrollback should remain as fast as or faster than today; the strongest prospective gain is cold or rapidly repeated navigation.

## Proposed topology

This is a responsibility map, not a request for a new package or another semantic store.

```text
Codex events -> canonical conversation -> transcript projection
                                            |
                              stable block order, fold state,
                              IDs, revisions, source spans
                                            |
                                 TranscriptRuntime
                        one semantic cursor/anchor authority
                        latest navigation intent + generation
                              /             |             \
                             /              |              \
                    motion resolver    geometry cache     window planner
                    { } gg G           scalar heights,    visible fragments,
                    Ctrl-U/D           row/point maps     directional prep
                             \              |              /
                              \             |             /
                              immutable presentation frame
                                            |
                           OpenTUI React viewport and measurement
                                            |
                          revision-guarded geometry feedback
```

- **Navigation index:** Extend existing runtime indexes with only the stable order, IDs, fold state, source spans, and height summaries needed to locate candidate destinations. Avoid a second canonical transcript or duplicated cursor/anchor ownership.
- **Geometry:** Reuse exact measurements where available. Evaluate retaining small row/source-point maps for recently visited and directionally adjacent blocks after heavy native renderables are evicted. Key validity by block identity, content revision, width, style revision, fold state, and presentation variant. A scalar height alone does not always resolve a source-point cursor.
- **Preparation:** Select visible and near-future fragments based on the latest motion direction, with bounded work and memory. Discard obsolete work by intent generation; validate revisions before accepting measurements. Keep the existing windowing principle rather than mounting a fixed 1,000-block tail: the [connected benchmark](./transcript-navigation-benchmark.md) found substantially higher latency and memory with large overscan.
- **Presentation:** Publish a coherent frame from the one runtime authority. Show available local content through a cheap readable representation when rich decoration is pending. Use a skeleton only if content is genuinely unavailable, and never assign an estimated-height skeleton an exact cursor or row destination. The current complete plan holds payload references; metadata-only indexing or future on-demand resource access would be a separate, measured step.

The useful analogy from Linear's local-first design is that interactions can consult locally available state before expensive synchronization or presentation work. Vimex already has local canonical data and a local Codex app-server, so this proposal does **not** imply copying a remote delta-sync protocol. Grok's [scrollback preparation research](./transcript-runtime-research.md#scrollback-continuity-follow-up-2026-09-22) is a closer reference for variable-height terminal geometry.

## Implementation slices to investigate

1. **Measure the current path.** Extend the dirty mixed connected benchmark to report key acceptance, first readable paint, exact destination paint, rich-content completion, preparation work, cache hit rate, and memory separately. Include cold/warm revisits, held `Ctrl-U/D`, reversal, `{`/`}`, `gg`/`G`, fold expansion, width changes, large single blocks, and the opt-in 100k-render-block capacity fixture.
2. **Make intent and freshness explicit.** Route navigation through a runtime-owned, generation-tagged motion request. Let semantic destinations resolve from stable block order. Ensure old preparation and native measurement cannot overwrite a newer intent. Preserve the current single cursor and anchor authority.
3. **Prepare exact row geometry ahead of travel.** Test whether bounded directional preparation and a compact geometry cache make common `Ctrl-U/D` destinations exact within the first frame. Where geometry is cold, keep provisional state visibly distinct from the committed semantic cursor and settle without a false placement or direction reversal.
4. **Render visible detail selectively.** Compare cheap readable local content, cached native fragments, and optional placeholders. Do this only after destination correctness and geometry validity are established. Evaluate startup, memory, and large-block costs before retaining additional data.

Likely touchpoints are `packages/transcript/src/runtime.ts` and its index/window/geometry modules, plus `packages/ui-opentui-react/src/transcript/use-transcript-layout.ts`, `TranscriptViewport.tsx`, and key bindings. These are tentative locations, not a mandate to add new layers. The work crosses runtime and UI boundaries and should be developed in a separate feature branch with reviewable vertical slices.

## Correctness and decision gates

- Compare final semantic cursor, anchor, and painted placement with an independent native-placement oracle where feasible; a full-mounted control is diagnostic, not automatically correct.
- No blank frame, semantic direction reversal, stale-intent overwrite, lost fold state, or detached-reader jump. Repeated preparation of an unchanged destination should be a no-op.
- Compare latency distributions, not just one process run. Record actual key intervals and distinguish input dispatch from first paint and exact destination. Include memory and startup costs at 10k and the opt-in 100k scale.
- Keep scrollback uncapped by default. Consider paging or eviction only if measured memory demands it, with a real resource-access contract and stable navigation metadata for unloaded content.

The implementation decision should follow a prototype that improves **exact destination latency** and subjective held-key behavior without unacceptable memory or startup cost. A fast provisional paint alone is insufficient evidence.

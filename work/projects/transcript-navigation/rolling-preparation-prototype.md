# Rolling preparation around the viewport

Status: superseded by [retained-window planning](retained-window.md), 2026-11-06. The rolling scheduler, runtime growth API, and old flags were removed; the implementation and commands below are historical. This extends the prepared-neighborhood behavior observed at `gg` to interior viewports. The transcript viewport owns priority whether focus is in the composer or transcript.

## Why this slice

The existing planner deliberately retains a much larger native neighborhood near the head and tail than in ordinary interior scrollback. The defaults are 300 edge blocks / 900 indexed rows plus lookahead. Existing tests demonstrate retained roots and correct subsequent paging, not that every offscreen Markdown leaf is already highlighted.

The first implementation reuses that native-layout and geometry-cache path, incrementally and within bounds. It does not create a hidden second transcript or a second source/row mapping engine. The earlier prepared plain-command bridge remains optional and narrower than general transcript content. Fully independent compact Markdown preparation is not established by this prototype.

## Research behind the approach

- [Virtuoso range planning](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/src/sizeRangeSystem.ts) retains a surrounding range and uses directional overscan; its [scroll-seek example](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-seek-placeholders/) reduces detail while preserving item size.
- [CodeMirror viewport planning](https://github.com/codemirror/view/blob/main/src/viewstate.ts) retains a margin around the viewport, and its [parser scheduling](https://github.com/codemirror/language/blob/main/src/language.ts) prioritizes visible content before farther work and yields within work budgets.
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer) exposes overscan, cached measurements, and scroll-end signals, while documenting the rendering-cost tradeoff of larger overscan.
- [Chromium's rendering architecture](https://chromium.googlesource.com/chromium/src/+/main/docs/how_cc_works.md) separates active presentation from pending work and coherently activates prepared results. This is an architectural analogy; Vimex has no independent compositor thread.

The proposed transfer is continuous bounded preparation, stable neighborhood retention, superseding obsolete targets, and release changing priority rather than beginning all work from scratch. These libraries do not supply a drop-in implementation for Vimex's native source mapping.

## Intended invariants

- Existing runtime cursor, anchor, selection, folds, and jump history remain authoritative.
- Preparation follows the latest viewport and must not supersede valid navigation intent.
- Small movements retain overlapping native roots and valid cached geometry.
- Enlargement happens in yielded steps. New input does not wait for the entire neighborhood to fill.
- Thread/layout changes invalidate inappropriate retained work. Canonical history remains uncapped.
- Required visible layout and source mapping keep their existing correctness gates. Native mounting is not a certificate of completed offscreen highlighting.

## Validation approach

Compare disabled, stop-only, and continuous preparation on explicit cold interior destinations, plus natural held navigation followed by several discrete keys or wheel inputs. Use both focus surfaces. Equal held input counts do not guarantee equal destinations when repeat coalescing is active, so report actual landing anchors rather than claiming matched locations from input count alone.

Observe exact keyboard-intent resolution, painted feedback, retained root identities, window transitions, bounded neighborhood growth, and preservation of semantic/native placement. The independent sender prevents the input producer from stalling with the UI, but headless timing is still not physical-terminal acceptance. Changes in a few milliseconds alone do not establish the desired UX.

## Implemented prototype

`TranscriptRuntime.prepareNeighborhood` grows a disposable window using indexed row bounds and stable block keys. Each scheduled step starts from existing overscan and adds at most one viewport of desired rows and eight desired blocks, toward limits of 900 rows / 300 blocks. Required visible ranges, existing edge policy, and whole-block boundaries can exceed these optional budgets.

The UI scheduler holds one replaceable request and reads the latest viewport when it executes. It yields between batches and waits for coherent native geometry before another changed-window batch. While moving, it biases extra space toward the movement direction. Release, or a 120 ms quiet fallback, removes that directional preference. Small movements retain the prepared neighborhood; approaching its boundary recenters preparation. Thread, width, style, and incompatible generation changes invalidate it.

These timers share the UI thread. They do not make a single expensive native mount or Markdown measurement interruptible, and mounting does not imply completed offscreen syntax highlighting. This experiment tests whether retained native neighborhoods buy enough readiness before considering a separate preparation representation.

Run locally:

```sh
VIMEX_NAV_REPEAT_CONTROL=1 VIMEX_NAV_PREPARED_PAINT=1 VIMEX_NAV_ROLLING_PREPARATION=1 bun run start
```

Omit `VIMEX_NAV_ROLLING_PREPARATION` for the control. Add `VIMEX_NAV_ROLLING_PREPARATION_MODE=stop-only` to suppress preparation during motion and compare preparing only after stopping. All new behavior remains opt-in.

## Evidence and limits

- Six domain tests cover incremental growth, stable block identities, viewport movement independent of cursor, distant relocation/layout reset, tail streaming, and measured-height refinement. Existing runtime/window/planner tests also pass.
- Five scheduler tests cover yielding, current-target selection, reversal, stop-only behavior, and cancellation. Two connected tests preserve cursor, viewport, selection, draft, and focus, then retain actual prepared native roots through four Ctrl-E inputs with either focus surface. Retention is measured after preparation; native roots may change while the initial neighborhood is being refined.
- A 1,000-item Markdown natural hold with 600 repeats recorded 23 preparation steps, including 14 directional steps and four window changes during movement. No blank frames were observed. Subsequent keyboard intents resolved in 7–27 ms in that run; this does not reproduce the reported cold-landing delay or establish an improvement over the control.
- The first explicit cold-target comparison is **not valid latency evidence**: jumping to item 512 immediately before follow-up input allowed old native placement to restore a location near item 968. This occurred with preparation disabled too. The input cancels pending jump restoration before native placement reaches the requested target. Treat direct-jump-plus-immediate-input ordering as a separate investigation; do not attribute those 100–190 ms timings to successful navigation at item 512.

The benchmark also supports `VIMEX_NAV_INITIAL_VIEWPORT_INDEX` to begin at a known interior source location before constructing the native renderer, then navigate naturally. This avoids the extra release-time jump. Equal starts still do not guarantee equal stopping locations under repeat coalescing. Multiple landing probes use `VIMEX_NAV_LANDING_KEYS=d,e,e,d,y,wheel-down`; exact keyboard resolution and actual anchors matter more than the first paint alone.

An exploratory serial comparison used 1,000 Markdown items, initial item 512, 120 held repeats at 33 ms intervals, composer focus, independent sender, and the probe sequence above. Repeat control and prepared paint were enabled in all modes. Each mode ran once; these are mechanism diagnostics, not statistically established latency results.

| Preparation | Release item / offset | Keyboard resolutions, ms (`d,e,e,d,y`) | Maximum mounted roots after release | Changed preparation steps during motion |
| ----------- | --------------------- | -------------------------------------- | ----------------------------------- | --------------------------------------- |
| Disabled    | 480 / 5571            | 8.1, 8.6, 13.0, 20.4, 7.0              | 2                                   | 0                                       |
| Stop-only   | 480 / 6534            | 14.1, 15.3, 16.4, 5.2, 15.7            | 12                                  | 0                                       |
| Continuous  | 480 / 6534            | 39.5, 18.5, 25.1, 11.4, 13.0           | 16                                  | 4                                       |

All three runs recorded zero blank frames. Continuous preparation performed work during movement and retained a larger neighborhood, but did not improve follow-up latency here. The disabled run also stopped at a different source offset. The experiment therefore remains opt-in and needs local UX feedback before broader adoption.

Validation: `bun run check` passed on the final source changes, including formatting, TypeScript, dependency boundaries, generated documentation, domain tests, isolated native UI tests, and the default terminal suite. `git diff --check` also passed. This is automated validation; physical-terminal UX acceptance remains unobserved.

## Follow-up investigations

1. Test held Ctrl-U/D followed immediately by discrete movement in a long real transcript, with either focus surface. Compare the flag off, continuous, and stop-only. Record whether the stopped location is immediately usable, whether movement itself worsens, and whether rendering visibly continues catching up.
2. Investigate the independent direct-jump/immediate-scroll placement race with a connected regression test. Preparation does not resolve this ordering problem.
3. If retained native neighborhoods do not improve the reported UX, investigate the remaining indivisible native mount/Markdown measurement work. More overscan can increase this work; separate compact preparation or finer rendering units may be needed.
4. A minor liveness limitation remains: after preparation finishes, a streaming/folding change can reset runtime preparation without changing the scheduler request key. Further growth then waits for the next navigation/release. A preparation invalidation epoch could restart it without scheduling work on every streamed token.

# Held navigation detail experiment

Status: opt-in investigation; not a production performance claim.

Follow-on work is organized in the [responsive transcript navigation project](../transcript-navigation/README.md), including external research, the architectural plan, and durable evidence summaries. This file remains the historical experiment record.

## Experience motivating the experiment

Russ reports hesitation while holding `Ctrl-U` and `Ctrl-D` through long transcript history, specifically when the destination has not yet been rendered or retained in memory. Cold window transitions are the primary case; warm revisits are a control, not a substitute. The intended experience is continuous, trustworthy movement: detail may arrive later, but content should not jump or reverse as it becomes detailed. This observation motivates the investigation. Timing measurements help explain that experience; they do not replace it or establish subjective acceptance.

The initial hypothesis is that deferring decoration during movement can reduce competition with navigation without changing screen-row geometry. OpenTUI does not expose a general safe suspension switch for rich rendering. Replacing Markdown with raw text changes wrapping and concealed syntax, so it would not isolate decoration cost.

## Narrow experiment

The experimental variant defers new fenced-code syntax highlighting in completed Markdown while half-page navigation is active. Markdown structure, concealment, row mapping, and already highlighted content remain intact. This tests one source of decoration work, not all parsing, React reconciliation, native layout, diff rendering, or terminal painting. A null result does not reject navigation/rendering decoupling.

The connected benchmark adds queued upward traversal followed immediately by downward traversal. Record actual key intervals, changed-paint gaps, and the first changed paint following each key alongside final cursor and anchor placement. A paint following a key is not proof that it has incorporated that key; these observations are scheduling diagnostics, not independent per-key destination latency.

## Review criteria

- Can the reader maintain orientation while holding a key and immediately reversing?
- Does text retain its position when highlighting arrives?
- Are pauses, blank frames, cursor reversals, or delayed movement visible?
- Does release promptly leave a fully readable, settled view?
- Do the experiment and control reach the same semantic destination under identical ordered input?

Use recorded headless timings to locate stalls and compare variants. Follow with actual-terminal observation before claiming the original experience improved. Keep the experiment opt-in until that review.

## Running it

Normal behavior remains the default. To try the variant in the offline demo:

```sh
VIMEX_NAV_DEFER_CODE_DETAIL=1 bun run start --demo
```

Hold `Ctrl-U`, reverse immediately with `Ctrl-D`, and release in a code-containing section. Compare with the same command without the environment flag. Completed Markdown's new code highlights wait for 120 ms without another half-page motion. Streaming content and already highlighted content retain existing behavior.

For a queued headless comparison, run both variants with identical settings. The held workload traverses upward before any navigation warmup, resets to the tail, then revisits the route and reverses. Initial setup still prepares the normal retained area; window transitions identify travel beyond that area, not proof that every destination was unmeasured:

```sh
VIMEX_NAV_WORKLOAD=held VIMEX_NAV_ITEMS=1000 VIMEX_NAV_REPEATS=100 bun scripts/benchmark-transcript-navigation.tsx
VIMEX_NAV_DEFER_CODE_DETAIL=1 VIMEX_NAV_WORKLOAD=held VIMEX_NAV_ITEMS=1000 VIMEX_NAV_REPEATS=100 bun scripts/benchmark-transcript-navigation.tsx
```

The gate reports deferred and released request counts to establish whether the workload actually exercises the variant. Idle release is not full highlight completion. Pending requests all resume at idle, including obsolete requests whose results native revision checks later reject; the prototype does not cancel those worker jobs or guarantee a bounded restoration cost.

## Observed result, 2026-11-05

**Do not enable this variant for normal use.** The narrow experiment did not demonstrate a useful improvement and did not preserve all connected navigation outcomes. Default behavior is unchanged.

After the full check completed, paired headless runs used 1,000 canonical items, the production window policy, 100 half-page keys per direction, and a requested 33 ms interval. The table reports gaps between paints with changed native scroll position or semantic cursor, including intentional input pacing; these are not input-to-pixel latencies or independent-trial percentiles.

| First traversal fixture | Control movement gap p50 / p95 | Deferred detail p50 / p95 | Window transitions | Deferred highlights |
| ----------------------- | ------------------------------ | ------------------------- | ------------------ | ------------------- |
| Mixed                   | 34.2 / 46.1 ms                 | 33.8 / 50.2 ms            | 5 in each          | 1                   |
| Markdown                | 34.9 / 46.5 ms                 | 34.3 / 45.2 ms            | 1 in each          | 3                   |

All these runs had zero blank captured frames. Mixed first traversal reached the same cursor and viewport. However, the warm-route reversal ended at item 967 with the variant versus the tail at item 999 in the control; a second variant run reproduced the same discrepancy. The Markdown first traversal retained the viewport but differed by three graphemes in cursor position; its warm reversal matched. These are observed mismatches, not a diagnosed root cause. The benchmark does not independently certify every intermediate direction change in a mixed-direction action.

Native focused tests establish unchanged character cells, height, and line information for the tested unconcealed code snippet before and after decoration. They do not establish connected half-page equivalence, as the diagnostic demonstrates. The full `bun run check` passed, along with flag-enabled focused cursor tests; the new workload exposes a gap beyond those assertions.

The treatment affected only one to three highlighting requests during the measured cold traversal. These runs neither validate the variant nor reject the broader movement/rendering separation. Investigate cold native window preparation and exact geometry availability next, retaining this first-traversal/reversal workload and the observed semantic discrepancies as diagnostic evidence. Actual-terminal UX acceptance remains outstanding.

Raw local diagnostic artifacts (temporary, not checked in): `/tmp/vimex-nav-held-{off,on}.json` and `/tmp/vimex-nav-held-md-{off,on}.json`.

## Cold geometry follow-up

The next investigation found a concrete stale-geometry failure behind the enabled variant's repeated reversal stall. At item 967's first Markdown fragment, native height was 39 rows but all 1,184 cached semantic points occupied row zero. Explicitly invalidating that block corrected 1,168 points into rows 3–38 without changing the native root height. The next `Ctrl-D` then advanced normally. This local intervention identifies an invalid navigation map; it does not establish that every reported real-session pause has the same cause. Diagnostic artifacts: `/tmp/vimex-nav-diagnosis.log` and `/tmp/vimex-nav-diagnosis.json`.

The profiling harness also needed a correction: it inherited OpenTUI's default target of 30 fps, whereas production explicitly targets 60 fps. The benchmark now matches production and records both target and maximum FPS. Earlier cadence figures above remain historical observations at the old setting, not production-equivalent latency evidence.

Preparation currently sorts measurement candidates visible-first but still processes all candidates synchronously, including overscan. Native preparation also performs lifecycle passes, whole-tree placement invalidation, Yoga calculation, and placement updates. Stage profiles must distinguish these operations: timing `calculateLayout` alone measures neither all preparation nor semantic geometry construction. Reducing offscreen work is a potential next experiment, after making geometry readiness reliable.

### Profiling limits and next hypothesis

A 10,000-item production-policy run at the corrected 60 fps setting crossed only two mounted-window transitions during its first held traversal. Its p95 gap between movement paints was 50.9 ms, and p95 time to the next changed paint was 34.0 ms. These are not exact-destination latencies. Instrumented native layout, placement-update, and runtime calls individually remained below 0.64 ms; the largest recorded React commit was 1.20 ms. The wrappers omit parts of lifecycle processing, geometry measurement, and other preparation, so they do not establish total blocking cost. Artifact: `/tmp/vimex-nav-profile-10000-60.json`.

A diagnostic with recent retention disabled crossed 64 windows at the older 30 fps setting, showing that the ordinary workload largely remained in prepared content. A CPU-profile attempt did not successfully emit its profile, and a later forced-cold 60 fps run did not complete validly. Neither provides reliable additional attribution. Do not turn these partial observations into a claim that the reported cold-navigation hesitation is absent or solved.

### Correctness repair

The underlying measurement issue was stale absolute ancestor screen caches for culled children, even when local layout offsets were already correct. Geometry extraction now consistently derives coordinates from recursive native layout `x`/`y` and subtracts the owning block in the same coordinate system. This avoids caching collapsed row maps without adding a per-frame descendant scan. A regression seeds a stale ancestor screen cache, verifies immediate correct row mapping, and verifies cache reuse after screen-cache repair and uniform scrolling.

With the repair, the formerly collapsed 1,184-point map spans rows 0–38 within its 39-row native fragment. At 60 fps, the baseline and deferred-highlight variants now match final cursor, viewport, and scroll position for first traversal, reset, and held reversal, with zero blank frames. Fourteen focused measurement tests and five flag-enabled cursor tests passed. Artifacts: `/tmp/vimex-nav-local-coords-{off,on}.json` and `/tmp/vimex-nav-placement-proof.log`.

This resolves the reproduced geometry stall, not a general latency guarantee. The earlier “do not enable” recommendation for the decoration experiment remains: no useful performance benefit has been established. The correctness repair applies independently of that flag.

Validation completed across the default suite. The initial full check exposed one outdated split-diff destination expectation; independent source-line and painted-native-row assertions established the corrected positions. After updating that regression, all ten navigation-destination tests passed, and the remaining UI files passed in their normal isolated-process mode. All earlier core, transcript scaling, and UI groups had passed in the full run. Final formatting, typecheck, dependency boundaries, generated-doc checks, and diff checks passed. No performance improvement claim is made from these correctness checks.

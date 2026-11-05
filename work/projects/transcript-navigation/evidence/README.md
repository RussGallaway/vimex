# Evidence checkpoint

[2026-11-05.json](2026-11-05.json) preserves selected metadata, measurement counters, final positions, and timing summaries from six synthetic headless runs. It includes fingerprints of the original artifacts. Raw frame/key traces remain temporary and are not recoverable from this summary; rerun the fixture when detailed attribution is needed.

The evidence was collected during the same development session before the main checkpoint. Runtime versions, fixture hashes, window policies, and actual key cadence summaries are retained. Upstream research is separate and is not performance evidence for this implementation.

## Outcome summary

- Coordinate repair: control and deferred-highlighting runs agree on final logical cursor, anchor, native cursor placement, and scroll position across held traversal/reset/reversal. The repaired 39-row block no longer maps all 1,184 points to row zero. See the [historical detail record](../../v1/transcript-navigation-detail-experiment.md).
- Offscreen budgeting: reduced-retention comparisons agree on logical/native cursor outcomes and show earlier feedback; production-policy long holds do not agree. Both completed with zero pending work and no blank captured frames. See the [historical budget record](../../v1/transcript-offscreen-measurement-experiment.md).
- A run's `status` is not a cross-run correctness verdict. A changed paint is a feedback opportunity, not proof that the individual key's exact destination is visible. Global indexed offsets can differ while logical/native positions agree because unvisited heights remain estimated.
- The complete default `bun run check` passed at the final experiment checkpoint. Flag-enabled focused suites also passed. These checks do not override the observed production destination disagreement or establish actual-terminal UX acceptance.

## Reproduce

Use Bun 1.3.6 and the repository's installed dependencies. The benchmark uses deterministic local fixture data, not a live Codex thread. Leave `VIMEX_NAV_DEFER_CODE_DETAIL` unset for the budget comparisons. Run variants sequentially on the same machine without competing test/build load.

Production-policy long traversal:

```sh
VIMEX_NAV_MEASUREMENT_DIAGNOSTICS=1 VIMEX_NAV_PROFILE_STAGES=1 VIMEX_NAV_WORKLOAD=held VIMEX_NAV_ITEMS=10000 VIMEX_NAV_REPEATS=300 bun scripts/benchmark-transcript-navigation.tsx > /tmp/navigation-control.json
VIMEX_NAV_BUDGET_MEASUREMENTS=1 VIMEX_NAV_MEASUREMENT_DIAGNOSTICS=1 VIMEX_NAV_PROFILE_STAGES=1 VIMEX_NAV_WORKLOAD=held VIMEX_NAV_ITEMS=10000 VIMEX_NAV_REPEATS=300 bun scripts/benchmark-transcript-navigation.tsx > /tmp/navigation-budget.json
```

Reduced-retention diagnostic: use `VIMEX_NAV_ITEMS=1000`, `VIMEX_NAV_REPEATS=100`, and add all three overrides to both variants:

```sh
VIMEX_NAV_RECENT_TAIL_BLOCKS=0 VIMEX_NAV_RECENT_TAIL_ROWS=1 VIMEX_NAV_OLDER_LOOK_AHEAD_ROWS=0
```

Those overrides are not recommended production settings. The long hold matters: a 100-key production-policy run can remain entirely inside prepared content and exercise no deferral. Confirm actual window transitions and deferred attempts before interpreting a comparison.

The harness now explicitly uses production's 60 fps target and records its cadence. Older experiment numbers at the default 30 fps are historical only. It permits bounded settlement of up to 400 renderer passes after the old 20-pass flush limit failed on a long control run. Preserve post-input settlement and pending counts when reviewing results.

For the corrected geometry comparison, use the held workload with 1,000 items and 100 repeats; compare the default against `VIMEX_NAV_DEFER_CODE_DETAIL=1`, with measurement budgeting unset. This is a correctness stressor, not a recommended daily setting.

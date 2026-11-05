# Offscreen measurement scheduling experiment

Status: investigation; default behavior remains unchanged.

Follow-on work is organized in the [responsive transcript navigation project](../transcript-navigation/README.md). Its research and plan address the correction-order problem exposed here; this file remains the historical experiment record.

## UX question

When held `Ctrl-U` or `Ctrl-D` first reaches unprepared history, can Vimex show the correct visible destination sooner by preparing nearby offscreen geometry afterward? The target is continuous, trustworthy movement with delayed surrounding detail. The user's reported cold-navigation hesitation motivates the experiment; synthetic timings explain particular behaviors rather than replacing that experience.

This follows the stale-screen-coordinate repair recorded in [the detail experiment](./transcript-navigation-detail-experiment.md). That repair remains enabled independently. The earlier deferred-code-highlighting experiment remains disabled for these comparisons.

## Hypothesis and boundaries

Current measurement sorts visible roots first but processes all candidate roots synchronously. An opt-in scheduler can protect visible and navigation-required geometry while limiting optional offscreen measurement in each native frame. The budget must survive repeated preparation passes within one frame. Deferred work must eventually progress, and old work must be discarded when its roots leave the current window.

This experiment does not avoid mounting native content, parsing Markdown, or native layout. It cannot bound the cost of one exceptionally large visible block. Final cursor, anchor, painted position, and ordered reversal behavior must agree with the control before any responsiveness claim.

## Evidence to collect

- First traversal before navigation warmup, then same-route reversal.
- Production 60 fps settings, actual dispatch intervals, and actual window transitions.
- Visible versus deferred measurement counts and work per frame.
- First useful movement, exact destination, and deferred completion treated separately.
- No blank frames, stale destinations, false cursor placement, or lost input.
- Production retention first; reduced-retention runs explicitly labeled diagnostic.

Startup and post-release background work must be recorded so a faster first paint cannot conceal excessive settling cost. Headless evidence does not establish physical-terminal smoothness.

## Prototype policy

The proposed flag is `VIMEX_NAV_BUDGET_MEASUREMENTS=1`. Half-page input arms a 120 ms activity window. While armed, each native frame allows up to eight optional offscreen measurement attempts or 2 ms of cumulative measurement work; required geometry bypasses that limit. Startup remains unchanged. Deferred candidates stay pending, request another frame, and are pruned with their departed window roots. Once input is idle, the prototype resumes ordinary draining.

The time threshold is a soft batch budget, not preemption: an individual measurement can exceed it. Idle draining may itself produce a burst; its cost and anchor stability are part of the review. This is a deliberately narrow test of scheduling, not the final background-preparation policy.

## Implementation and correctness checks

The opt-in scheduler is implemented behind the flag above. Required geometry includes intersecting visible roots and the fragments containing the cursor, viewport anchor, and selection endpoints. Optional candidates remain ordered by distance. The production default does not perform the added endpoint classification.

A native regression exercises real deferred candidates, verifies visible geometry is measured, checks that repeated same-frame calls cannot replenish the budget, then advances native frames until pending work reaches zero without changing semantic cursor or viewport. Focused validation passed: nine native layout tests, ten flag-enabled navigation-destination tests, five flag-enabled cursor tests, and two budget tests.

Diagnostics count measurement attempts, including cached calls and repeated deferrals; deferred attempts are not unique blocks. The pending count describes the last measured scrollbox, while cumulative work is renderer-wide. The comparison harness uses one transcript pane. The idle deadline is not a completion signal; settlement requires the pending measurement count to reach zero.

## Exploratory results

Single paired runs used 60 fps and a requested 33 ms key interval, with deferred-code highlighting disabled. The production 1k-item/100-key comparison never left the prepared window and deferred no work, so it establishes only warm-path compatibility.

| Workload                               | Next changed-paint p95, control → budget | Movement-gap p95, control → budget | Deferred attempts | Final logical/native cursor agreement |
| -------------------------------------- | ---------------------------------------- | ---------------------------------- | ----------------- | ------------------------------------- |
| Production 10k, 300 up                 | 62.8 → 39.4 ms                           | 65.1 → 50.2 ms                     | 1,397             | No                                    |
| Production 10k, 300 up then down       | 167.3 → 45.7 ms                          | 57.4 → 51.3 ms                     | 6,683             | No                                    |
| Reduced-retention 1k, 100 up           | 39.3 → 29.4 ms                           | 53.3 → 47.6 ms                     | 1,119             | Yes                                   |
| Reduced-retention 1k, 100 up then down | 36.5 → 28.6 ms                           | 53.7 → 47.7 ms                     | 1,307             | Yes                                   |

Reduced retention used zero recent-tail blocks, a one-row recent-tail budget, and zero older lookahead. These settings are diagnostic, not a production recommendation. Changed-paint latency is a feedback opportunity, not exact individual-key acknowledgement. Gaps include input pacing. These are individual paired runs, not repeat-trial distributions.

Every completed action had zero blank frames and zero pending measurements after settlement. Reduced-retention logical cursor, anchor, and native cursor position agreed; absolute indexed scroll offsets differed because historical height estimates can differ. Production did not agree: the cold control ended at item 9735 offset 16 versus item 9734 offset zero with the budget. After reversal the control ended at item 9993 offset 230, while the budget reached the tail at item 9999 offset 59. The control is a comparison, not an independent exact-destination oracle, so disagreement establishes unresolved correctness rather than proving which result is right.

The long control initially exceeded the harness's 20-frame flush allowance. With a bounded 400-pass allowance it completed; this backlog is not silently excluded from timings. Pending completion and post-input settlement remain recorded in the artifacts.

**Keep the flag off for normal use.** Deferring optional measurement demonstrably reduces work during these traversals and improves observed feedback, but the production destination disagreement prevents promoting this prototype. Reduced-retention cold background attempts fell from 584 to 425, and their measured total time fell from roughly 251 to 154 ms. These measurements cover block measurement calls, not all native preparation or physical terminal output.

Artifacts: `/tmp/vimex-budget-long-{off,on}.json` and `/tmp/vimex-budget-cold-{off,on}.json`.

## Remaining coupling and next diagnostic

Read-only trace comparison found a comparable painted cold divergence around key 190 near heading/table-rich content. The repeated route differed as early as key two: the same logical cursor had a different scroll offset and preferred anchor row. Matching key counts at a paint is not proof of identical fully resolved input state, so these observations narrow the investigation rather than establish an exact causal sequence.

Each accepted measurement batch updates the runtime height index and may replan the mounted window and spacers. The UI then restores anchors while resolving queued row remainders. Changing batch boundaries can therefore change when prefix-height corrections interleave with half-page motions, even when the anchor's own fragment is measured. This is the leading explanation, not a proven root-cause repair.

The next focused diagnostic should capture measurement batches' changed heights, top spacer, pending row remainder, native `scrollBy`/`scrollTo`, and preferred screen row around the first few repeated-route keys. Compare at fully resolved key boundaries. A future scheduling design must preserve exact row-motion semantics across these corrections; simply skipping more offscreen candidates is insufficient.

Full `bun run check` passed after implementation, including default native tests and the injected-budget regression. Flag-enabled focused cursor and navigation suites also passed. These checks validate the retained default and targeted scheduler behavior; they do not resolve the production-workload final-position disagreement above. The experiment remains opt-in and unpromoted.

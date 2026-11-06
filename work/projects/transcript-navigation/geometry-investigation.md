# Ordered motion and geometry investigation

Date: 2026-11-05. Branch: `feat/transcript-prepared-navigation`.

## Question

Why did changing offscreen measurement scheduling change the destination of the same held half-page input? Before moving navigation onto prepared rows, we need input semantics that survive incremental preparation. This investigation concerns that prerequisite; it does not establish the cause or resolution of Russ's reported cold-navigation hesitation.

## Ordered evidence

The benchmark now optionally records key dispatch/return, UI intent acceptance, individual row steps and remainders, cursor resolution, geometry batches, native scroll calls, and paints. Dispatch does not imply resolution. `VIMEX_NAV_WARM_REPEATS` shortens the repeated route independently of the initial traversal. Trace retention is capped, with an explicit dropped-record count. Traced timing includes diagnostic overhead and is not performance acceptance evidence.

The 10,000-item mixed fixture with 300 initial upward keys and four repeated upward/downward keys reproduces disagreement after the input queue drains. The [retained summary](evidence/2026-11-05-ordered-trace.json) includes the command, per-key steps, geometry changes, and hashes of temporary raw artifacts.

| Repeated key | Baseline                                | Measurement-budget variant             |
| ------------ | --------------------------------------- | -------------------------------------- |
| 1            | Same logical destination                | Same logical destination               |
| 2            | Item 9993, offset 213, preferred row 10 | Same source cursor, preferred row 9    |
| 3            | Item 9992, offset 769, preferred row 10 | Item 9992, offset 751, preferred row 8 |
| 4            | Item 9992, offset 475                   | Item 9992, offset 565                  |
| 8            | Tail                                    | Tail                                   |

Key 3 is resolved as one seven-row step in the baseline and six plus one in the variant. The variant's second key reports seven rows of movement, but its settled native top changes by six. An intervening placement correction therefore matters even when the queue is fully drained. Final tail equality hides the earlier differences. Neither run is automatically the correctness oracle.

Reducing to 1,000 items did not reproduce repeated-route disagreement. The fixture changes content with item index; a smaller fixture must preserve relevant local content, not just reduce its count.

## Reduced native reproduction

A 30-item native fixture divides only navigation row steps into one-row pieces; anchor compensation remains unrestricted. Two identical Ctrl-U inputs then produce different source cursors and native tops. This isolates step-subdivision sensitivity without needing the offscreen measurement budget.

Two mechanisms emerged during the prototype:

1. Cursor-follow is resolved after each partial step. Snapping to nearby text around blank rows can redefine the desired screen position for the remaining part of the same key. The intended screen row and column should survive all remainders of that key.
2. A same-height geometry update can still change a source point's local row. In the reduced split-diff case, a culled descendant's local placement changes when it becomes visible, provoking a one-row anchor correction. Root height equality does not certify a complete row map.

The prototype applies two narrow changes:

- Retain the original desired screen row and column on a half-page input's queued remainders. A subsequent key establishes its own target; one-line clamping is unchanged.
- Before an uncached block measurement, refresh computed native placement parent-first within that block, including culled descendants. Use the existing public `updateFromLayout` operation after checking for finite computed Yoga layout. This does not calculate another Yoga layout or traverse the entire transcript; cache hits retain their existing fast path. Newly reconciled nodes without computed layout await normal preparation.

The reduced fixture distinguishes the effects. Target retention alone aligns the source cursor but leaves native tops 290 versus 289. Placement preparation alone aligns the native top at 289 but leaves source offsets 769 versus 700. Together they satisfy the reduced oracle: two seven-row movements, preserved native cursor row, exact source position, painted closing-brace row, and downward reversal. A separate native regression checks that the first measured row for a culled child agrees with its later visible placement, even when the root height does not change.

Do not suppress legitimate anchor compensation merely to make variants agree. The subtree refresh adds work on cache misses; these correctness results do not establish a latency improvement.

## Long-fixture result

The [post-prototype trace](evidence/2026-11-05-ordered-trace-fixed.json) repeats the same 10,000-item/300-initial-key/four-each-way scenario. All eight repeated keys now agree on source cursor and native painted cursor placement. Painted cells agree for keys 1–7; key 8 differs only in the animated Working spinner. Every action's final cursor, viewport, and native cursor point agrees. Neither run reports blank frames or dropped trace records.

At key 2 the stored logical anchor still differs: the baseline anchors item 9993 offset 228 at row 10; the budget variant anchors item 9992 offset 568 at row 1. Both describe the same painted viewport and cursor. This is evidence of repaired destination behavior in this scenario, not proof that all internal representations or measurement schedules are equivalent.

The [longer comparison](evidence/2026-11-05-long-reversal.json) repeats the original 300-key cold traversal followed by 300 upward and 300 downward keys. Cold traversal and tail reset now match in final source cursor, logical anchor, native cursor placement, and cells. After the full reversal, the source cursor matches at item 9992 offset 787, but **a real one-row viewport disagreement remains**: baseline row 0 versus budget-variant row 1, with a preceding diff row visible in the latter. Both report zero blank frames and zero pending measurement backlog. This is the next correction-order target; do not promote the budget experiment or mark the coherent-commit gate complete. Arbitrary delayed geometry and real-terminal cold UX also remain unvalidated.

The placement helper also relies on the existing native preparation invalidation when Yoga changes within the same renderer frame: `updateFromLayout` itself retains its native frame cache. It is not a standalone replacement for the preparation lifecycle.

Read-only follow-up found the one-row difference already present at the reversal midpoint, so it is not only a release-time drain issue. A remaining hypothesis is the native-edge fallback: when `advance()` moves zero rows, it can ask `scrollDestinationAtRow(indexedRow + requested)` using an estimated height index, publish an anchor, and consume the intent. Different available measurements could reinterpret that remaining displacement. The current evidence does not prove this path caused the residual mismatch. Trace its acceptance/resolution boundary and reduce it before changing the fallback; paints with equal dispatched-key counts are insufficient.

## Validation

Focused native checks pass: 15 measurement tests, 11 destination tests, and five cursor-motion tests. The existing split-diff expectation was corrected to preserve the original native cursor row 10 rather than accepting subdivision drift to row 8. Its source positions (769 then 484) are also checked against the text painted on that native row. Type checking and diff checks pass; the full repository check is the integration gate.

The first full check exposed a selection-clipping defect: after switching a distant Visual selection's window, a reusable layout had a screen translation of 179 rows. Point lookup applied that translation, while block filtering and local-row clipping used the untranslated bounds. The resulting empty native selection failed the existing test. Applying the same translation to clipping fixes the failure without changing the expected selection. Positive and negative translation regressions pass in the 17-test layout suite; the unchanged native distant-selection regression also passes.

The complete `bun run check` subsequently passed on the final implementation (local log: `/tmp/vimex-prepared-navigation-final-check.log`), including formatting, types, boundaries, generated documentation, and all default tests. Project links, evidence JSON, and `git diff --check` also pass. This validates the checkpoint's regressions, not the unfinished schedule-invariance and real-terminal UX gates.

## Remaining gates

The [source mapping follow-up](source-mapping-investigation.md) traces the residual disagreement to a repeatable provisional Markdown mapping transition and records the subsequent readiness prototype. It supersedes the unproven fallback hypothesis above for that reproduced transition.

The proposed prepared-row architecture is still pending. Exact row preparation must use the renderer's layout rules; scheduling geometry differently must not reinterpret accepted movement. A real-terminal cold traversal and deliberate rich-rendering delay remain necessary to evaluate the requested experience. No synthetic result here establishes instant navigation.

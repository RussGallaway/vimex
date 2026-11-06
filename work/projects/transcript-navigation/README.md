# Responsive transcript navigation

Status: research checkpoint and architectural prototype plan, approved for investigation on 2026-11-05. Correctness repairs and a standalone text-row preparation prototype are implemented on the feature branch; prepared-row navigation is not yet integrated or accepted for production.

The [one-row follow-up](source-mapping-investigation.md) now matches all 600 resolved movements in the original paired long-route diagnostic. It identifies and repairs provisional Markdown mapping and out-of-order geometry publication; it does not establish instant cold navigation.

## Start here

Russ reports hesitation when holding `Ctrl-U` and `Ctrl-D` through long transcripts, especially when the destination has not yet been rendered or retained in memory. The goal is immediate, continuous movement with rendering detail catching up: reversals respond promptly, releasing the key stops predictably, and text does not jump as detail arrives.

That experience is the reason for the work. A small improvement in a synthetic next-paint metric does not establish that the problem is solved. Cold traversal and actual-terminal observation are essential; a warm-window benchmark is only a control.

- [Research](research.md): upstream implementations, author writeups, transferable mechanisms, and limitations.
- [Plan](plan.md): ownership constraints, staged implementation, correctness gates, and the next concrete investigation.
- [Evidence](evidence/README.md): durable summaries of the local experiments and reproduction commands.
- [Geometry investigation](geometry-investigation.md): ordered-input traces and the reduced native reproduction guiding the first implementation slice.
- [Source mapping investigation](source-mapping-investigation.md): the one-row follow-up, delayed Markdown reproduction, and scoped readiness prototype.
- [Prepared text prototype](prepared-text-prototype.md): native row preparation without rich renderables, painted-cell parity, cost evidence, and remaining semantic/integration gates.

The [v1 specification](../v1/spec.md), [UX contract](../v1/ux.md), [architecture](../v1/architecture.md), and [topology](../v1/topology.md) remain authoritative. This project proposes an implementation direction; it does not change Vim motions or create another canonical cursor/anchor owner. The existing [navigation-decoupling design](../v1/transcript-navigation-decoupling.md) remains relevant context.

## Checkpoint

Main contains the coordinate repair in `fc67798` and the disabled experiments/benchmark in `53a0361`. The complete default check passed on this implementation state before documentation-only changes; documentation links, formatting, types, boundaries, generated documentation, and diff checks were revalidated while preparing this checkpoint.

| Work                                           | State                         | What it establishes                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native geometry coordinate repair              | Implemented, default behavior | Prevents stale ancestor screen caches from collapsing a multiline block's navigation map; connected held navigation and native regression evidence passed.                   |
| Held-navigation benchmark                      | Implemented                   | First traversal, repeated route/reversal, production 60 fps, actual window transitions, backlog and feedback diagnostics. It is not an independent exact-destination oracle. |
| Deferred code highlighting                     | Opt-in, not promoted          | No useful performance benefit established. Helped expose the repaired geometry defect.                                                                                       |
| Offscreen measurement budget                   | Opt-in, not promoted          | Less measurement work and earlier feedback in exploratory runs; production-policy destination disagreement remains unresolved.                                               |
| Coordinated geometry commits and prepared rows | Planned                       | Architectural direction accepted for prototyping; no general instant-navigation claim.                                                                                       |

Both `VIMEX_NAV_DEFER_CODE_DETAIL` and `VIMEX_NAV_BUDGET_MEASUREMENTS` remain unset for normal use and for the initial architecture baseline. Preserve them as diagnostic controls until the new prototype makes them obsolete; do not combine their effects inadvertently.

Historical experiment records remain at [detail deferral and geometry repair](../v1/transcript-navigation-detail-experiment.md) and [offscreen measurement scheduling](../v1/transcript-offscreen-measurement-experiment.md). Their temporary raw artifact paths are supplemented by the committed [evidence summary](evidence/2026-11-05.json).

## Working agreement

- Checkpoint the validated repair, disabled experiments, and this research on `main`.
- Develop the architectural prototype on `feat/transcript-prepared-navigation`, as explicitly requested by Russ. This is an exception to the repository's normal main-first workflow.
- Keep small, reviewable implementation slices and a baseline comparison. No release, push, or pull request is implied by this checkpoint.
- Use file claims and one integration owner for shared-index operations. Branch changes require checkout-wide coordination.
- Reopen this directory when resuming. Start with the next action in [plan.md](plan.md), not another budget adjustment or an unmeasured renderer rewrite.

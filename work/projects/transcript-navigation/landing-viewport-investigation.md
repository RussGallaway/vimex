# Navigation immediately after stopping

Status: investigation and narrow opt-in scheduling prototype, 2026-11-06.

Russ confirms repeat control stops held navigation immediately, but reports that subsequent individual Ctrl-U/D/Y/E or wheel inputs at the landing location still feel blocked by rendering and measurement. The priority is the **transcript viewport**, regardless of whether focus or the cursor is in the composer or transcript. The goal is a usable landing viewport, then nearby preparation and visual detail, with obsolete work unable to delay a new input.

## Findings

General transcript measurement already orders visible blocks before nearby offscreen blocks. Ordering alone does not prevent a synchronous measurement batch from delaying input. Visible Markdown also requires accurate source mapping before ordered movement can resolve. Earlier removal of this requirement caused cursor/source and viewport discrepancies; do not treat it as disposable highlighting. The readiness check already limits required Markdown leaves to the current viewport.

The prepared command-output bridge separately processed still-valid queued jobs in insertion order. A job can remain valid while outside the viewport because the containing block is still mounted. The queue could also reject new visible work when its 16 slots held older work. These are concrete scheduling opportunities, but this bridge only serves final completed command-output fragments: it cannot explain or solve a Markdown-only delay.

## Reproduction

The connected benchmark now sends a discrete probe from an independent process immediately after the held input's release, **before settling**. Both focus surfaces are supported:

```sh
VIMEX_NAV_REPEAT_CONTROL=1 VIMEX_NAV_PREPARED_PAINT=1 \
VIMEX_NAV_INDEPENDENT_SENDER=1 VIMEX_NAV_KITTY_HELD_INPUT=1 \
VIMEX_NAV_WORKLOAD=held VIMEX_NAV_ITEMS=1000 VIMEX_NAV_SHAPE=markdown \
VIMEX_NAV_REPEATS=300 VIMEX_NAV_LANDING_KEY=u \
VIMEX_NAV_LANDING_FOCUS=composer VIMEX_NAV_LANDING_DELAY_MS=0 \
VIMEX_NAV_TRACE=1 VIMEX_NAV_TRACE_CELLS=0 VIMEX_NAV_LANDING_DIAGNOSTICS=1 \
bun scripts/benchmark-transcript-navigation.tsx > /tmp/vimex-landing.json
```

Use `u`, `d`, `y`, `e`, `wheel-up`, or `wheel-down` for the probe and `composer` or `transcript` for focus. The probe runs only after the first held-up route, avoiding a settling step before the interaction under examination. `landingProbe.resolvedMs` matches the exact accepted keyboard intent; first semantic change/paint is only a feedback opportunity and can include a retained active hold remainder. Mouse feedback lacks an independent exact intent acknowledgement. Post-stop motion is intentional when the probe is enabled and must not be labeled overshoot. This uses connected headless stdin/mouse input, not a physical terminal.

`VIMEX_NAV_LANDING_DIAGNOSTICS=1` adds readiness waits and per-pass native layout / measure-and-publication timing to the existing optional navigation trace. These distinguish waiting for correct visible text from synchronous work, without bypassing correctness guards. `preparedWork` snapshots expose bridge counters before and after each action.

## Viewport-first prototype

`VIMEX_NAV_VIEWPORT_PREPARATION=1`, together with prepared painting or geometry, changes only optional prepared command-output job scheduling:

- Select the job nearest the current viewport center when it runs, with visible jobs ahead of offscreen jobs.
- Re-read the viewport after movement rather than retaining enqueue-time coordinates.
- If the queue is full, admit nearer work by displacing a more distant optional job.
- Preserve native fallback, stale-result rejection, and geometry publication ownership.

Neither cursor location nor focused surface participates in priority. Native preparation remains indivisible within a bounded command fragment; this flag does not add preemption, change Markdown readiness, or budget general measurement. It is not yet evidence that the reported landing lag is fixed.

## Initial results

All 12 Markdown combinations completed with zero blank frames. These are single runs on 1,000 items, 300 held repeats at 33 ms, repeat control and prepared painting enabled, and no deliberate settling before the probe. The timing matrix is diagnostic rather than a physical-terminal latency guarantee:

| Probe  | Composer focus: intent resolved | Transcript focus: intent resolved |
| ------ | ------------------------------: | --------------------------------: |
| Ctrl-U |                       29.539 ms |                         32.315 ms |
| Ctrl-D |                       10.538 ms |                         21.750 ms |
| Ctrl-Y |                       15.128 ms |                         11.970 ms |
| Ctrl-E |                       12.674 ms |                         20.184 ms |

Both Ctrl-U cases waited once for visible Markdown readiness. Measured individual native layout and measure/publication slices were shorter than the full response interval. This has not reproduced a prolonged post-release rendering stall. Raw artifacts are `/private/tmp/vimex-landing-{composer,transcript}-{u,d,y,e,wheel-up,wheel-down}.json`.

### A retained motion can cancel the first new wheel input

The transcript-focused wheel-down trace revealed a distinct UX defect candidate: the released upward hold retained an active one-row remainder (sequence 299). After accepting a one-row downward wheel input, preparation applied the old -1 row and then the new +1 row, returning to the same visible location. There was a semantic transition but no changed semantic paint relative to the probe's starting viewport. This is not a lost wheel event or proof of slow rendering: old motion and new intent opposed one another before paint.

The original repeat-control implementation deliberately preserved active partial motions for cursor/anchor coherence. That motivated a focused follow-up: establish a coherent stop at the currently painted viewport so a new input does not first finish an old displacement. The correction must not discard pending cursor/anchor work or bypass Markdown readiness.

The follow-up correction retains that bookkeeping but marks a released/reversed active repeat as stopped. At the existing coherent boundary, after pending anchor/restore/cursor work resolves, it discards only that repeat's remaining displacement before advancing another input. Same-direction repeat replacement does not stop the active motion. Discrete, counted, and Visual navigation are not repeat-tagged and remain exact. This refinement is enabled by the existing `VIMEX_NAV_REPEAT_CONTROL=1`; it does not require the optional prepared-job scheduling flag.

Four connected regressions observe an actual unresolved partial repeat in a rich Markdown fixture, then send release and an opposite one-row key or wheel event in a microtask outside preparation. Both focus surfaces are covered. They assert that the stopped sequence executes no further row steps, the new input does execute, the final viewport changes, and focus is preserved. They do not mutate internal navigation queues.

The unsettled-boundary cases also exposed incorrect wheel accounting. `lastScrollTop` can precede movement already performed by the hold. Subtracting it from the post-wheel native position mixes the two motions: an old -6 rows plus a new +1 wheel row can be interpreted as a -5 wheel movement. The hook now captures the first wheel event's native origin before OpenTUI applies wheel movement, retains that origin across a wheel batch, and uses it to compute and replay only the wheel displacement. Native acceleration and clamping remain authoritative. This origin correction applies to ordinary wheel input as well as the experiment; repeat truncation still requires repeat-tagged experimental input.

Disabling the settled-boundary remainder correction makes all four partial-motion tests fail on actual extra post-release row steps, not merely a missing diagnostic marker. With both corrections enabled, the connected repeat suite passes 12 tests and 49 assertions, including no premature truncation during the uninterrupted same-direction hold. The targeted boundary includes pending anchor work rather than excluding that difficult case.

### Prepared scheduling coverage and limitation

The ordinary command fixture queued no eligible prepared work, so its flag-on/off timing difference establishes nothing about the new scheduler. The benchmark therefore supports `VIMEX_NAV_UNFOLD_ALL=1` to expose command fragments and records this override. With all tools unfolded, the flag-enabled command route prepared five additional fragments and painted prepared rows, but recorded **zero reprioritizations and zero queue displacements**. Its 16.524 ms landing resolution is not evidence of improvement from the new policy. Raw artifact: `/private/tmp/vimex-landing-command-unfolded.json`.

Targeted bridge tests do exercise dynamic viewport movement, center-out order, and a full old queue admitting nearer work. The scheduling prototype is a validated capability, not a demonstrated fix for Russ's remaining catch-up report. The retained-repeat and wheel-origin corrections above address reproduced input interference; physical-terminal follow-up is still needed to assess how much of the reported feeling they resolve.

## Final validation

Full `bun run check` and `git diff --check` passed on the final implementation. Focused checks also passed: 12 connected repeat tests (49 assertions), all 39 existing scrolling regressions with repeat control enabled, 13 prepared-bridge tests, and flag-enabled connected painting/native geometry parity tests. The initial full check was intentionally interrupted while the newly discovered remainder/origin corrections were developed; the final fresh check completed successfully. Final full-check log: `/private/tmp/vimex-landing-final-check.log`.

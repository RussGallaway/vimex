# Held navigation after release

Status: opt-in repeat-control prototype, 2026-11-06. Default navigation remains unchanged; physical-terminal acceptance remains pending.

Russ reports substantially better Ctrl-U/D scrolling with `VIMEX_NAV_PREPARED_PAINT=1`, followed by continued movement after releasing a sufficiently long hold. This is the next UX target: continuous movement while held, prompt reversal, and a stable location after release while detail finishes rendering.

## Verified mechanism and remaining hypothesis

`use-transcript-layout.ts` appends manual row intents to `pendingScrollRows`, consumes the oldest intent, requeues unfinished displacement at the front, and schedules another frame while movement remains. Opposite-direction input joins the same queue. Cold preparation yields between layout passes, but yielding does not bound accumulated movement. These mechanisms can explain the report; they do not establish which buffer dominated Russ's particular run.

At the investigation baseline, the renderer configuration did not request enhanced keyboard event reporting. Installed OpenTUI supports `useKittyKeyboard: { events: true }`, `eventType`, `repeated`, and a separate `keyrelease` event. Bindings reduced scroll input to direction and amount. Legacy terminal input does not reliably distinguish held repeats from deliberate repeated presses.

## Research

- [Kitty keyboard event types](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#event-types) distinguish press, repeat, and release when requested and supported. Events have no physical timestamp; a buffered release still cannot interrupt synchronous application work.
- [CodeMirror's viewport model](https://codemirror.net/docs/guide/#viewport) and [measurement scheduling](https://github.com/codemirror/view/blob/main/src/editorview.ts) support coalescing obsolete rendering work around the latest destination. They are not evidence for discarding deliberate navigation commands.
- [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/) explains why time-sliced consumption still accumulates backlog when production outpaces consumption. This concerns terminal output, not a proposal to apply XON/XOFF to keyboard navigation.
- [Neovim lazyredraw](https://neovim.io/doc/user/options/#'lazyredraw') defers some redraw work; it does not establish held-repeat cancellation semantics.

## Reproduction requirements

Use a credential-free, long synthetic transcript. Compare cold and revisited regions, paint flag on/off, and hold-stop versus hold-reverse. Separate external input send time, application delivery time, and actual viewport movement. Record queue depth, outstanding distance, movement after the sender stops, and reversal response.

The existing connected benchmark's same-event-loop sender stalls with the application and then catches up. Its `lastKeyToFinalPaintMs` also includes viewport/cursor/cell settlement rather than strictly movement. An independent sender and movement-specific diagnostics are needed before interpreting it as a physical-release reproduction. A headless connected test still does not establish terminal-parser or physical-emulator behavior.

Initial control: 1,000 mixed items, 120 repeats at a requested 33 ms interval, paint flag enabled, production window policy. Final destination paint followed the last mock dispatch by 83.949 ms on first traversal and 50.544 ms on the warm reversal route. No blank frames. This did **not** reproduce prolonged overshoot. Raw diagnostic: `/private/tmp/vimex-held-release-prepared.json` (temporary artifact, not durable evidence).

A longer Markdown run **did reproduce application-level movement after input stopped**: 1,000 items, 300 Ctrl-U repeats at 33 ms, followed by a reset and a 300-up/300-down reversal. After the last delivered input, first traversal recorded 55 further cursor/viewport-changing painted frames over 1,144.556 ms. The reversal route recorded 36 over 860.443 ms. At the final reversal enqueue, 27 motion intents remained (sequences 874–900), including an unfinished one-row displacement followed by 26 seven-row motions. No blank frames were recorded. These are semantic position changes, not merely highlighting changes. This establishes an application FIFO backlog under this synthetic load; it does not identify physical terminal buffering or guarantee identical user-session timing.

```sh
VIMEX_NAV_PREPARED_PAINT=1 VIMEX_NAV_WORKLOAD=held \
VIMEX_NAV_ITEMS=1000 VIMEX_NAV_SHAPE=markdown \
VIMEX_NAV_REPEATS=300 VIMEX_NAV_WARM_REPEATS=300 \
VIMEX_NAV_TRACE=1 VIMEX_NAV_TRACE_CELLS=0 \
bun scripts/benchmark-transcript-navigation.tsx > /tmp/vimex-held-release-markdown.json
```

For the counts above, compare consecutive `paintFrames`' serialized `cursor` and `viewport`, counting changes whose `atMs` exceeds the final `keyDispatches` entry. Native `top` alone is insufficient because virtualization and geometry corrections can change its coordinate space. The first changed paint after input stops may have been prepared just before stop; dozens of continued semantic changes and the pending-intent trace establish sustained continuation here. Timing values are single-run diagnostics, not latency guarantees.

The benchmark now supports `VIMEX_NAV_INDEPENDENT_SENDER=1`. An independent Python process sends paced key records over a pipe to the connected headless input harness. A request/reply handshake bounds the clock mapping uncertainty. This avoids stalling the input producer alongside the app, but still does not exercise the terminal parser. It reports both runtime cursor/viewport changes and painted changes after the external sender stops. Trace capture now includes the cold held-up action.

With that flag added to the command above, first traversal settled in about 30 ms, while the reversal reproduced a 934.987 ms painted movement tail and 933.529 ms runtime semantic-change tail. There were 28 pending intents at final delivery, 76 subsequent runtime semantic changes, and 38 subsequent semantic-change paints. Maximum input delivery delay was 20.311 ms and clock uncertainty 0.059 ms. The application queue, rather than pipe delivery, accounts for most of the observed tail. Raw diagnostic: `/private/tmp/vimex-independent-markdown.json`.

An unflagged same-event-loop control also reproduced a 914.274 ms reversal tail (37 semantic-change paints); first traversal settled in 26.287 ms. Therefore the symptom is not exclusive to prepared painting. These runs are not a controlled speed comparison: a baseline benchmark and later repository validation overlapped parts of the independent run. First-traversal timings varied substantially. The supported conclusion is reproducible backlog, not an estimated production latency or a paint-flag performance regression.

## Candidate experiment

Keep individual presses, explicit counts, and selection semantics exact. For positively identified held repeats, investigate bounded outstanding motion and superseding unstarted repeats on release or reversal. Independently coalesce obsolete preparation work. A latest destination alone does not prevent overshoot if that destination already includes seconds of queued repeats.

Verify terminal event support before relying on releases. Keep any legacy timing heuristic separate and opt-in: silently dropping rapid identical legacy keys would change Vim semantics. Test input handling under long synchronous preparation, since release-aware cancellation alone cannot receive a stop promptly while the event loop is blocked.

## Investigation checkpoint validation

Before the repeat-control prototype, the independent sender completed a short mixed-content sanity run and the long Markdown reproduction. Typechecking, scoped formatting, `git diff --check`, and the full `bun run check` passed. That checkpoint changed only the benchmark and project documentation.

## Repeat-control prototype

`VIMEX_NAV_REPEAT_CONTROL=1` requests enhanced keyboard event reporting and enables repeat-aware Ctrl-U/D navigation. Only protocol-confirmed repeats are replaceable. The queue retains at most one unstarted repeat in addition to any active partial motion. Release discards unstarted repeats for that key; reversal discards pending repeats in the old direction. A started motion finishes its coherent cursor/viewport update. Release matching does not require Ctrl still being held.

Deliberate presses, explicit count holds, and Visual-mode holds retain exact behavior. Context changes discard pending replaceable repeats. Legacy terminal input remains exact because it cannot reliably distinguish a hold from deliberate repeated presses. This prototype requires the terminal and any intervening multiplexer to forward enhanced events; enabling the flag alone does not guarantee that support.

Try it with the prepared painting experiment:

```sh
VIMEX_NAV_PREPARED_PAINT=1 VIMEX_NAV_REPEAT_CONTROL=1 bun run start
```

For the independent-sender reproduction, add `VIMEX_NAV_KITTY_HELD_INPUT=1` and `VIMEX_NAV_INDEPENDENT_SENDER=1` to the earlier benchmark command. The benchmark feeds actual encoded press/repeat/release bytes through the renderer's stdin parser, but uses a pipe-driven headless App rather than a PTY/emulator. It releases the previous direction at reversal and the last held key when the sender stops. Compare with and without `VIMEX_NAV_REPEAT_CONTROL=1`; hold input encoding remains identical.

The initial sequential comparison used 1,000 Markdown items, 300 repeats per direction at 33 ms, prepared painting enabled, and no concurrent validation workload:

| Reversal route                                    | Repeat control off | Repeat control on |
| ------------------------------------------------- | -----------------: | ----------------: |
| Pending motions at final key delivery             |                 23 |                 1 |
| Runtime cursor/viewport changes after sender stop |                 62 |                 0 |
| Last runtime change after stop                    |         762.855 ms |              None |
| Last changed paint after stop                     |         764.079 ms |          0.213 ms |

The prototype pruned 77 unstarted repeat intents over the reversal route. This intentionally changes distance traveled under overload; it does not drop deliberate presses or counts. First traversal likewise had no runtime semantic changes after stop with the flag on. Raw artifacts: `/private/tmp/vimex-repeat-control-baseline.json` and `/private/tmp/vimex-repeat-control-prototype.json`. These are single-run diagnostic observations, not a guarantee of zero movement after release. Synchronous work can still delay receiving input, and active partial movement is intentionally retained.

Prototype validation passed: 2 queue-invariant tests, 8 connected raw-protocol tests, all 39 existing scrolling regressions with repeat control enabled, an enabled real-process PTY smoke test, and full `bun run check`. Connected coverage includes release after Ctrl is lifted, reversal without a preceding release, deliberate legacy and enhanced-protocol presses, flag-off repeat behavior, counted/Visual holds, and context changes. The active partial-motion preservation invariant is also tested. Physical terminal and multiplexer event forwarding remain unverified.

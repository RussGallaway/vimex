# Vimex v1

Vimex is a full-screen, keyboard-first terminal client for the Codex app server. Its interaction model is Vim: Normal, Insert, Visual, and Command modes. Its visual direction takes inspiration from OpenCode while preserving Codex as the agent harness.

This directory is the design authority for v1.

## Documents

- [spec.md](./spec.md) defines the product contract, scope, and acceptance criteria.
- [ux.md](./ux.md) defines interaction behavior, layout, modes, and key semantics.
- [architecture.md](./architecture.md) defines runtime boundaries, state ownership, and data flow.
- [topology.md](./topology.md) defines the repository tree and dependency rules.
- [roadmap.md](./roadmap.md) defines the implementation sequence and phase exit criteria.
- [implementation-status.md](./implementation-status.md) tracks verified implementation and remaining acceptance work.
- [acceptance-matrix.md](./acceptance-matrix.md) maps every numbered release criterion to evidence and remaining verification.
- [decisions.md](./decisions.md) records settled decisions and open questions.
- [review-rounds.md](./review-rounds.md) records parallel review repairs and measured scrolling performance.
- [diff-review.md](./diff-review.md) compares OpenCode diff behavior and the Vimex review direction.
- [transcript-runtime.md](./transcript-runtime.md) defines compact activity presentation, streaming isolation, and the path to size-independent transcript windowing.
- [transcript-runtime-research.md](./transcript-runtime-research.md) records the external research and reasoning behind the transcript runtime design.
- [transcript-runtime-implementation.md](./transcript-runtime-implementation.md) tracks implementation order, exit criteria, measurements, and evidence.
- [transcript-windowing-dogfooding.md](./transcript-windowing-dogfooding.md) maps observed windowing UX symptoms to architectural boundaries and provides the evidence and triage workflow for fix-forward dogfooding.
- [transcript-navigation-benchmark.md](./transcript-navigation-benchmark.md) defines the dirty mixed-content navigation baseline and separates input latency from scaling-test duration.

## Document ownership

When documents overlap, use this precedence:

1. `spec.md` owns product requirements and release scope.
2. `ux.md` owns observable interaction behavior.
3. `architecture.md` owns runtime boundaries and state ownership.
4. `topology.md` owns source placement and import direction.
5. `roadmap.md` owns implementation order.
6. `decisions.md` records why a choice was made; it does not override the current specification.
7. Specialized normative design documents refine these authorities for one subsystem without reversing their dependency or ownership rules.
8. Implementation ledgers record execution status and evidence; they do not define architecture.

## Working definition

> Vimex is Codex, operated like Vim and presented as a full-screen workbench.

The first release succeeds when a user can run a real Codex thread, navigate and copy its streaming Markdown transcript without touching the mouse, compose while reading any earlier point in the transcript, inspect tool and edit activity, switch or fork threads, resolve approvals, and use the client as a first-class Herdr pane.

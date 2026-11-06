# Transcript architecture and topology refactor

Date: 2026-11-06. Baseline: `78ccb72`, the retained-window checkpoint accepted through local UX feedback.

## Scope

Preserve the current navigation UX, scheduling, flags, window budgets, cursor/anchor semantics, source mapping, and runtime publication behavior. This pass reorganizes implementation responsibilities and their file topology. It does not optimize streaming or change when work executes.

The existing package boundaries remain authoritative: Workbench owns presentation runtime lifetimes and ingress; Transcript owns semantic state and renderer-neutral frames/planning; the OpenTUI adapter owns native measurement, readiness, and input binding. A file move does not change that ownership.

## Domain topology

```text
packages/transcript/src/
  runtime.ts                # sole presentation-frame publisher
  window.ts                 # explicit, compatible public facade
  window/
    types.ts                # block/window contracts
    block-plan.ts           # persistent block storage and updates
    blocks.ts               # immutable projection and fragmentation
    activity.ts             # activity grouping and window assembly
    addressing.ts           # stable keys and source-point lookup
    planner.ts              # pure range selection and retention
```

Internal modules import their dependencies directly, not through the public facade. Explicit facade exports preserve the existing API without exposing new internal assembly helpers. The planner can now be reviewed independently of Markdown fragmentation and persistent-tree implementation.

## UI topology

```text
packages/ui-opentui-react/src/transcript/
  TranscriptViewport.tsx    # component composition remains feature-owned
  TranscriptNode.tsx
  MarkdownMessage.tsx
  ...                       # other transcript presentation components
  navigation/              # input/settlement bindings, repeat control, tracing
  native-layout/           # measurement, placement and Markdown readiness
  prepared/                # prepared representation, cache, paint and tests
  experiments/             # opt-in detail and measurement-budget policies
```

Tests and harnesses move with the responsibility they exercise. Consumers import the new location directly; no forwarding files are left behind in the UI transcript root. Existing recursive test discovery and per-file native-process isolation remain unchanged.

The navigation hook still owns the existing settlement protocol. Extracting that protocol into a state machine or changing its transitions is deliberately outside this structural pass. Likewise, the runtime remains a single publisher rather than being split into independently publishing services.

## Design rationale

[Design Patterns for Humans](https://github.com/nilbuild/design-patterns-for-humans/blob/master/readme.md) treats patterns as contextual guidelines, not mandatory classes. Here the useful boundaries are a plain policy function for window planning, adapters for native behavior, and one owner for navigation settlement. No generic services directory, event bus, factory hierarchy, or additional preparation queue is introduced.

The retained-window mechanism follows [CodeMirror's range coverage checks](https://github.com/codemirror/view/blob/main/src/viewstate.ts) and [Virtuoso's range retention](https://github.com/petyosi/react-virtuoso/blob/master/packages/react-virtuoso/src/sizeRangeSystem.ts). This refactor preserves that mechanism rather than revisiting its policy.

## Parked streaming investigation

Russ reported slower movement while navigating through the growing transcript, then explicitly asked to preserve the accepted UX and focus on structural improvement. Streaming behavior is unchanged here.

Read-only investigation found full semantic Markdown projection on each changed delta and an unfragmented running-message block. A separate off-window reproduction found new viewport, selected-window-array, and geometry references despite identical selected block objects, keys, geometry values, and logical viewport. Neither result alone establishes the cause of the reported visible-stream slowdown. Keep these as future investigation leads, not incidental fixes hidden in a refactor.

## Validation contract

Review moved implementation bodies independently of changed import paths; verify the public domain API, runtime import graph, and recursive test inventory. Run the package boundary verifier, relevant existing navigation/domain regressions, the retained-window opt-in checks, and the full repository check. Preserve test expectations rather than relaxing them to accommodate the new paths. No performance improvement is claimed from structural changes.

Independent review verified:

- All 95 domain declarations match the checkpoint after excluding imports, export modifiers, comments, and source locations. All 39 public exports are preserved; the extracted runtime dependency graph is acyclic.
- All 78 affected UI/consumer files retain identical parsed implementations after excluding only import/export module paths and comments/source locations. Every one of the 587 checked import/export targets resolves to its prior dependency under the move mapping.
- The UI test inventory is unchanged: 86 test files before and after. There are no relocation-sensitive filesystem or asset references in the moved files.
- The 122 focused domain tests and 20 focused UI tests pass, including retained-window behavior for both focus surfaces and repeat/stop behavior.
- `bun run check` passed on the final source tree, including formatting, TypeScript, dependency boundaries, generated documentation, all domain tests, isolated native UI tests, and the default terminal suite. `git diff --check` passed. Source links affected by relocation were updated in the project documents.

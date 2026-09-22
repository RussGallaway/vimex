# Vimex v1 Decisions

This is a lightweight decision log. Change a settled decision only through a new entry that supersedes it; preserve the original reasoning.

## Settled

### D-001: Codex app server is the harness

**Decision:** Vimex is a client of `codex app-server` rather than a fork or wrapper around the existing Codex TUI.

**Reason:** App server exposes threads, turns, streaming items, approvals, forks, model configuration, token usage, and agent activity while keeping Codex responsible for execution and persistence.

### D-002: OpenTUI React is the presentation stack

**Decision:** Use `@opentui/core`, `@opentui/react`, and `@opentui/keymap` with TypeScript and Bun.

**Reason:** OpenTUI supplies the needed full-screen renderer, flex layout, scrollbox, Markdown, diff, textarea, clipboard, and layered keymap primitives. React is the preferred binding for this project.

### D-003: Vim has four modes

**Decision:** The only user-visible interaction modes are Normal, Insert, Visual, and Command.

**Reason:** This matches the established Vim mental model. Focus, overlays, active turns, and tail following are orthogonal state.

### D-004: Following is viewport state

**Decision:** The transcript viewport has a tail or logical-position anchor. It is not a mode.

**Reason:** A user must be able to compose in Insert mode while either following output or reading an earlier location.

### D-005: Transcript selection is semantic

**Decision:** Cursor and Visual selection use logical transcript positions and retained Markdown source.

**Reason:** Terminal-cell selection cannot survive reflow, streaming, folds, or offscreen selection and cannot offer reliable rendered-text versus source-Markdown copying.

### D-006: Use a modular monolith

**Decision:** Use Bun workspaces with packages for bounded contexts and volatile adapters, producing one TUI application.

**Reason:** This enforces import boundaries without introducing deployment or service complexity.

### D-007: Herdr is a first-class adapter

**Decision:** Ship a Herdr integration package while keeping Vimex independently executable.

**Reason:** Herdr should own launch and outward lifecycle metadata, while the core client remains portable and testable.

### D-008: OpenCode is design reference, not architecture

**Decision:** Borrow OpenCode's full-screen layout, density, compact tool presentation, Markdown/diff usage, session concepts, and responsive behavior. Implement independent transcript, folding, selection, and Vim semantics.

**Reason:** OpenCode demonstrates a strong visual solution, but its current TUI is Solid-based and contains UI-local state and mouse-oriented behaviors that do not satisfy Vimex requirements.

### D-009: Public plugins wait

**Decision:** V1 exposes internal extension points but no stable public plugin ABI.

**Reason:** Publishing an ABI before the transcript and command models settle would freeze premature abstractions.

### D-010: Transcript runtime is a renderer-neutral presentation model

**Decision:** Keep one canonical conversation and semantic transcript state. A per-presentation `TranscriptRuntime` derives cached immutable frames, owns damage and windowing policy, and accepts disposable block measurements from renderers. Detached reading pins a presentation revision rather than creating another transcript store.

**Reason:** One terminal state may have multiple coherent presentations. This keeps navigation semantics independent of OpenTUI, prevents hidden streaming from invalidating a detached reader, supports revision-guarded incremental work with safe rebuilding, and establishes the Stage 5 render-block windowing seam without introducing another authority or package.

### D-011: Reasoning is canonical but not primary transcript content

**Decision:** Retain reasoning items in canonical `ConversationState`, but exclude them at the conversation-to-transcript projection boundary. Represent an active turn with one pane-level `Working · elapsed` heartbeat and a completed turn with one source-less `Worked for …` footer when observed timing exists. Reserve direct reasoning presentation for a future inspector rather than primary transcript rows.

**Reason:** The primary transcript is the user's durable work record, not a lossless protocol dump. Excluding reasoning before semantic transcript state is created removes repetitive rows from navigation, search, selection, copying, unseen counts, geometry, and future window planning. Canonical retention preserves diagnostics and future inspection without introducing a second authority.

### D-012: Homogeneous settled activity is a runtime presentation batch

**Decision:** Preserve every tool and command as a canonical semantic item, and let `TranscriptRuntime` derive `TranscriptActivityBatch` relationships for two or more adjacent, settled items in the same activity family. The protocol adapter supplies structured `web-research`, `read`, or read-only provider metadata; presentation titles never determine grouping. A batch is compact only while all children remain folded. Expanding the lead item, navigating to a hidden child, anchoring there, or selecting it restores the ordinary child rows. Running, failed, interrupted, approval, edit, write, and destructive activity remains individually prominent.

**Reason:** Repeated safe reads, searches, and provider calls are useful as one work unit after completion but must remain individually inspectable and semantically addressable. A runtime-owned relationship gives every presentation the same policy, keeps React from becoming a second transcript model, and preserves canonical IDs for search, copy, marks, jumps, forks, detachment, and future render-block windowing.

## Open decisions

### O-001: Insert-mode submit key

Evaluate `Enter` submit with a newline chord versus `Enter` newline with a submit chord across Kitty, WezTerm, Terminal.app, iTerm2, SSH, tmux, and Herdr. Normal-mode `Enter` submits regardless.

### O-002: State library

Choose the smallest external-store implementation that supports narrow React subscriptions and framework-independent application commands. The domain model must not depend on this choice.

### O-003: Markdown source mapping

Determine whether OpenTUI exposes enough rendered-block metadata or whether Vimex needs its own incremental Markdown parse and projection before rendering.

### O-004: Context display semantics

Confirm whether the primary display should be consumed tokens, remaining tokens, or both. Always retain exact values in a detail view.

### O-005: Queue versus steer default

Choose the default action when the user submits while a turn is active. The UI must make the selected intent visible and reversible before dispatch when practical.

### O-006: Distribution

Choose source install, compiled binary, npm package, Homebrew formula, or a staged combination after the runtime and native dependency shape is proven.

## References

- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [OpenTUI keymap documentation](https://opentui.com/docs/keymap/overview/)
- [OpenTUI ScrollBox documentation](https://opentui.com/docs/components/scrollbox/)
- [OpenTUI Markdown documentation](https://opentui.com/docs/components/markdown/)
- [OpenTUI clipboard documentation](https://opentui.com/docs/core-concepts/clipboard/)
- [OpenCode TUI source](https://github.com/anomalyco/opencode/tree/dev/packages/tui)

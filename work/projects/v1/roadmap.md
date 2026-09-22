# Vimex v1 Roadmap

## Delivery strategy

Build vertical slices through a fake gateway first, then connect the real Codex app server. The riskiest work is stable transcript interaction under streaming and reflow, so it precedes broad feature coverage.

Each phase ends with a demonstrable behavior. Dates are intentionally omitted until the first two spikes establish actual OpenTUI and protocol effort.

## Phase 0: technical spikes

### Work

- Bootstrap Bun, TypeScript, React, `@opentui/core`, `@opentui/react`, and `@opentui/keymap`.
- Verify full-screen alternate-screen startup and reliable restoration.
- Verify a fixed composer beneath a sticky scrollbox.
- Generate TypeScript schemas from the installed Codex app server and record its version.
- Establish JSON-RPC stdio initialization and one real thread round trip.
- Test terminal key fidelity for Escape, Control keys, Alt/Meta, and submit/newline candidates.
- Test host clipboard and OSC52 in local and Herdr-hosted terminals.

### Exit

A disposable spike can submit one prompt, stream Markdown, keep the composer fixed, detach and reattach the viewport, and restore the terminal on exit.

## Phase 1: interaction and transcript foundation

### Work

- Implement Normal, Insert, Visual, and Command state machines.
- Implement focus independently from mode.
- Define transcript nodes, logical positions, cursor, selection, and viewport anchor.
- Project fake streaming events into Markdown transcript nodes.
- Implement `j/k`, `Ctrl-e/y`, `Ctrl-d/u`, `gg`, `G`, and focus movement.
- Implement tail attachment, detachment, unseen output, and resize-preserving anchors.
- Implement a minimal Vim composer buffer and per-thread draft model.

### Exit

The streaming-anchor acceptance test passes: the user can scroll back, write while output continues, preserve the reading position through resize, and use `G` to resume following.

## Phase 2: real Codex conversation

### Work

- Finish the versioned Codex transport and mapping layer.
- Normalize threads, turns, messages, reasoning, commands, file changes, MCP calls, and unknown items.
- Implement start, resume, list, switch, steer, interrupt, and status updates.
- Render Markdown, tool cards, commands, and responsive diffs; represent reasoning through turn-level activity while retaining it canonically for future inspection.
- Populate thread name, model, effort, context, cwd, branch, and run state.

### Exit

A real Codex task can run end to end with no raw protocol types crossing into UI or domain packages.

## Phase 3: transcript operations

### Work

- Implement semantic block and message motions.
- Implement fold state and `za/zo/zc/zM/zR`.
- Implement search and match navigation.
- Build Markdown source maps and URL indexes.
- Implement Visual character and line selection.
- Copy rendered text and canonical Markdown.
- Implement URL motions, `gx`, and URL picker.

### Exit

Visual copying survives streaming, folding, and resize; URL opening and every fold operation work without a mouse.

## Phase 4: sessions, forks, agents, and approvals

### Work

- Add searchable session picker and per-thread view restoration.
- Add message-boundary fork flow.
- Add parent and child agent navigation.
- Add approval queue, badge, overlay, and keyboard decisions.
- Ensure overlays use focus contexts rather than additional modes.

### Exit

The user can switch and fork threads, visit a child agent, return to the exact parent view, and resolve approvals entirely from the keyboard.

## Phase 5: Herdr integration

### Work

- Package Herdr detection and launch support.
- Report thread ID and lifecycle state.
- Report model, context, cwd, branch, and approvals metadata.
- Route external actions through an interceptable handler.
- Validate clipboard and terminal restoration within a Herdr pane.

### Exit

Vimex is launchable and observable as a first-class Herdr pane while remaining independently runnable.

## Phase 6: hardening and release

### Work

- Add configuration, theme, and key-override loading.
- Profile large transcripts and streaming rerenders.
- Add protocol contract fixtures and unknown-event coverage.
- Test small terminals, low-color terminals, SSH, tmux, and Herdr.
- Handle app-server exit and restart paths.
- Add terminal signal and restoration tests.
- Write install, configuration, key reference, troubleshooting, and contribution docs.

### Exit

All acceptance criteria in `spec.md` pass, the supported terminal matrix is documented, and a new user can install and complete a real Codex task without undocumented setup.

## Critical path

```text
OpenTUI shell
  -> logical transcript
  -> Vim state machine
  -> streaming anchors
  -> real Codex adapter
  -> Visual copy and folds
  -> sessions and approvals
  -> Herdr
  -> hardening
```

Features that do not exercise this path should not delay validation of the transcript model.

## Agreed command-surface follow-up

- Shared slash and Ex actions, validated argument completion, command usage help, direct model/thinking arguments, session favorites/switching, follow, and explicit queue/steer submission are implemented.
- `/skills`: discover current-directory skills via the app-server catalog, handle catalog invalidation, and present a keyboard picker.
- Preserve path-qualified skill references in drafts, queued messages, retries, and steering; send structured skill inputs through the adapter rather than relying on ambiguous name text.

## UX improvements identified during fold review

These are follow-up candidates, not completed features or changes to v1 acceptance gates:

- Collapsed tool summaries: show output line counts and preserve visible failure/status information so users can decide what to expand.
- Code-block actions: keyboard copy for a complete fenced block, with clear confirmation; investigate independent fenced-block folding (currently folds apply to transcript tool/edit items).
- Dedicated `/diff` and `:diff` review: source-labeled file/hunk navigation as described in `diff-review.md`.
- Fold-aware semantic navigation: clarify whether word motions traverse hidden content or skip closed blocks. Current semantic navigation may reveal a closed target; avoid changing that behavior silently while repairing performance.
- Large-history cold loading: keep the composer responsive while native Markdown geometry settles. Warm navigation improvements do not eliminate initial settlement work.

# Multi-Harness Vimex UX

## Experience first

Vimex should feel like one calm, Vim-native workbench even when several agent providers are available. The user chooses the harness deliberately, sees which account and billing path will be used, and then works in the same transcript, composer, navigation, and workspace model.

The user should be able to answer these questions at a glance:

```text
Which session am I looking at?
Which harness is running it?
Which account or auth profile will pay for it?
What can this harness do here?
What is the agent waiting for?
```

The workbench remains familiar. Harness differences appear where they change an action, a status, or a result.

## Golden path

```text
create session
  -> choose workspace + harness profile
  -> composition root creates the selected gateway bundle
  -> harness authenticates and starts a provider thread
  -> prompt -> typed workbench command -> adapter wire request
  -> provider deltas/facts/approval -> validated normalized events
  -> ConversationIngress -> canonical projection -> transcript/status
  -> disconnect -> preserve draft and mark outcome uncertain
  -> reconnect/reconcile -> explicit completed, failed, or unknown result
```

Vimex owns the local session, draft, view, and workspace association. The provider owns its thread, execution, authentication, and billing identity. A handoff creates a new provider thread; it never transfers provider identity.

## Glossary

```text
workspace        files, branch, worktree, and checks
Vimex session    local workbench identity and view state
provider thread  harness-owned execution identity
harness profile  executable/endpoint plus auth and billing observation
process health   local harness process/transport status
agent health     provider execution status
```

## Mental model

The unit of work is a session. A session binds one workspace, one harness, one auth profile, and one model selection.

```text
Workspace
  ├── Session A: Codex / ChatGPT login / GPT
  ├── Session B: Cursor / Cursor login / Composer
  └── Session C: Claude Code / Claude login / Claude model
```

Multiple sessions may share a workspace when the user wants to compare agents on the same branch. Independent tasks should use separate worktrees so agents cannot overwrite one another's work.

Changing the harness creates a new session or an explicit handoff. It does not silently mutate the provider identity of an existing session.

## Starting a session

The first-run path should be short and legible:

```text
:new
  -> choose workspace or cwd
  -> choose harness
  -> choose auth profile
  -> show account and billing status
  -> choose model and supported modes
  -> start session
```

For the current Codex release, the default remains Codex. A user who has never configured another harness should see no extra setup ceremony.

The harness picker should show availability without starting an agent:

```text
Harness                 Auth                         Status
Codex                   CLI login                    ready
Cursor                  ACP login                    not configured
Claude Code             CLI login                    ready
OpenCode                provider config              ready
```

If a harness cannot be started, Vimex should explain the next action, such as “run `codex login`” or “configure Cursor Agent,” and leave the workspace usable.

## Session header

Every active session has a compact identity block. It should fit in the status area while remaining inspectable through a command.

```text
payments-api  ·  CODEX  ·  GPT  ·  ChatGPT subscription  ·  Working
```

The expanded view shows:

```text
Session:    checkout-refactor
Workspace:   payments-api
Harness:     Codex
Profile:     personal-codex
Account:     ChatGPT subscription
Model:       GPT
Capabilities: approvals · fork · subagents · goals · usage
Connection:  connected
```

The account and billing line is a detected status, not a promise made by Vimex. If the harness cannot report it, show `billing status unavailable`.

## Switching sessions

The existing session picker remains the main navigation surface. It gains harness identity and capability summaries:

```text
checkout-refactor   CODEX    Working     GPT
review-auth         CURSOR   Idle        Composer
docs-migration      CLAUDE   Waiting     Sonnet
```

Opening another session restores its draft, transcript position, folds, selected pane, and harness status. The user should never need to reconstruct which provider owns a session.

The harness picker and session picker answer different questions:

```text
Session picker:     Which conversation should I open?
Harness picker:     Which runtime should create the next conversation?
```

## Common actions and capability-aware actions

Common Vimex actions keep their names and keys:

```text
prompt, steer, interrupt, approve, reject, copy, search, fold, fork, resume
```

The command surface should expose only actions supported by the selected harness. Disabled actions explain why:

```text
:fork
  Fork is unavailable for Cursor sessions.

:goal
  Goals are provided by Codex in this session.

:plan
  Cursor asks for plan approval through its provider flow.
```

The same concept may have provider-specific semantics. The common action remains stable; the adapter declares the details.

## Harness-specific features

Harness-specific features are first-class within their session and visibly namespaced:

```text
Codex:     :goal, :compact, background terminals
Cursor:    create plan, ask question, task activity
Claude:    skills, hooks, subagents
OpenCode:  custom tools, commands, plugins, replayable parts
```

The UI has three presentation levels:

```text
common transcript item
  -> capability-specific control
  -> provider extension card or diagnostic detail
```

Provider-specific cards must remain useful when copied or viewed outside their originating provider. They should show the provider name, feature name, state, and any action the user can take.

Cursor ACP is a useful model: some provider messages block the harness until the client answers, while others are notifications. Vimex should render both without treating every notification as a new transcript paragraph.

## Handoff between harnesses

A handoff is an explicit user action:

```text
:handoff cursor
  -> choose same workspace or new worktree
  -> review context package
  -> choose Cursor profile and model
  -> create a new Cursor session
```

Vimex should not claim that one provider conversation can resume inside another. It creates a new provider session with a handoff package:

```text
Handoff package
  - task summary
  - current workspace, branch, and worktree
  - relevant transcript excerpt
  - current diff
  - open questions and pending decisions
  - provider-neutral constraints
```

The original session remains available. The new session header links back to it.

## Parallel harnesses

Parallel sessions are visible as ordinary sessions with harness labels. The workspace view may group them:

```text
payments-api
  ├── CODEX   checkout-refactor    Working
  ├── CURSOR  test-repair          Working
  └── CLAUDE  review               Waiting for approval
```

The user can focus one session at a time. Background sessions continue according to their harness lifecycle and permissions. A notification should identify the workspace, session, harness, and event before opening it.

When two sessions share a branch or worktree, Vimex shows that fact and serializes mutating operations by default. Concurrent writers require explicit opt-in; read-only review sessions may remain parallel.

## Auth and billing experience

Vimex should make the billing path visible before work starts:

```text
Profile: personal-claude
Auth:    Claude Code login
Billing: Claude subscription
```

If an environment variable or API key changes the billing path, the profile status should say so. Vimex should not silently choose an API key when the user intended a subscription login.

Credentials remain with the provider harness or host environment. Vimex stores a profile reference and observable status, not raw secrets.

## Failure and recovery

Provider failures should be specific and recoverable:

```text
Harness unavailable      -> show setup action
Auth expired             -> show provider login action
Unsupported capability   -> explain availability and continue
Provider disconnected    -> preserve draft and view state
Unknown provider event   -> show diagnostic detail, continue session
Handoff failed           -> keep original session intact
```

The user should never lose a draft because a harness process exits.

## Commands introduced by this design

The exact key bindings can follow later. The command vocabulary should be stable first:

```text
:harness                 inspect or choose harness
:harness list            show installed and configured harnesses
:harness doctor          check executable, auth, and capabilities
:profile                 inspect or choose auth profile
:new                     create a session with a harness binding
:handoff HARNESS         create a new session from the current one
:capabilities            inspect the current session's features
:provider                open provider-specific controls
```

## UX invariants

- A session always shows its harness identity.
- Creating a session never silently changes an existing session's harness.
- Common Vimex actions keep their meaning across harnesses.
- Unsupported features explain themselves and do not create dead-end overlays.
- Provider-specific features are visible, named, and actionable.
- Auth and billing status appear before the first provider request when available.
- Handoff preserves the original session and makes the new context inspectable.
- Parallel sessions remain navigable with the existing Vim session and agent motions.
- Provider failures preserve local drafts and view state.

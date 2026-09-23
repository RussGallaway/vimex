# Vimex manual

<!-- man-date: September 18, 2026 -->

## NAME

vimex - a full-screen, Vim-operated interface for Codex

## SYNOPSIS

vimex [PATH] [--cwd PATH] [--thread ID] [--model NAME] [--config PATH]

vimex resume [ID] [--cwd PATH]

vimex resume --last [--cwd PATH]

vimex doctor [--config PATH]

vimex upgrade [--version VERSION]

vimex update [--version VERSION]

vimex --demo

vimex --help | --version

From a source checkout, use bun run start followed by these arguments. Published releases provide native bundles and the same command surface.

## DESCRIPTION

Vimex presents Codex conversations in a full-screen terminal. The composer stays fixed while the transcript streams. You can read older output and prepare a response without following new output automatically.

Codex owns execution, permissions, and conversation history. Vimex owns presentation, navigation, drafts, and local display preferences. Live sessions require an installed, authenticated Codex CLI; run codex login separately. The current adapter targets Codex 0.154.0. Source execution requires Bun 1.3.6 or later.

## OPTIONS

--cwd PATH: Working directory; defaults to the launch directory.

--thread ID: Resume an existing Codex thread.

--model NAME: Model for a new thread.

--config PATH: Read an alternate Vimex JSON configuration.

--demo: Run a local streaming demonstration without Codex credentials.

-h, --help: Print CLI usage without starting a session.

-V, --version: Print the Vimex version.

## CLI COMMANDS

resume ID opens an existing thread. resume --last opens the most recently updated session in the working directory. Bare resume opens the directory-scoped picker using an existing session; it does not create a new thread. An empty directory catalog reports an error.

doctor checks configuration, Codex, Git, terminal status, and installation ownership without starting a conversation.

upgrade and update are aliases. Homebrew installations delegate to brew upgrade; direct installations download and verify an archive before atomically switching the installed bundle. Source installations print update instructions. --version VERSION explicitly selects a release for direct installations; implicit latest updates never downgrade. There are no automatic updates.

## MODES AND COMPOSING

Normal, Insert, Visual, and Command modes follow Vim conventions. Focus and mode are separate: either the composer or transcript can have focus.

i enters Insert. Enter sends by default; Shift-Enter inserts a newline when supported by the terminal. Ctrl-Enter steers an active turn or sends when idle. Escape leaves editing or closes an overlay; from Normal mode, it interrupts the active turn. Ctrl-C also interrupts.

Up/Ctrl-K focuses the lowest visible transcript content row. Down/Ctrl-J focuses the composer. These bindings respect local menu and completion navigation.

Space e expands or collapses the composer. Expanded drafts can scroll internally. Space r opens rename with the old name shown as a hint and an empty replacement ready to type.

## TRANSCRIPT NAVIGATION

h/j/k/l move the text cursor; w/b/e move by word. 0 and $ move to line boundaries. gg goes to the start. G or t resumes following the tail. :tail and :follow do the same.

Ctrl-E/Y scroll down/up one row; Ctrl-D/U scroll half a viewport; Ctrl-F/B scroll a viewport in the transcript. Ctrl-E/Y/D/U also scroll the transcript while the composer keeps focus. Mouse-wheel scrolling preserves focus. Scrolling upward detaches tail following; scrolling back to the bottom resumes it automatically.

With transcript focus, half-page and full-page scrolling move the cursor with the viewport, keeping its screen row where possible. Ctrl-E/Y keep it on the same text until it would leave the viewport, then move it to a visible row. With composer focus, scrolling preserves the editing cursor and draft.

{ and } move by semantic block, keeping collapsed tool cards and compact tool groups closed as one stop each. Expanded tools retain paragraph navigation. Block jumps move through visible content before scrolling at the viewport edge, and continue from the updated cursor immediately after keyboard scrolling. [[ and ]] move by message. / and ? search from Normal mode in either pane; n/N repeat the search.

s opens Flash in Normal mode. Ctrl-G opens Flash from either pane, including composer Insert. Type visible text and then a label to jump. Escape cancels.

Ctrl-O moves backward through jumps and session visits; Ctrl-I moves forward. Legacy terminals may send Tab for Ctrl-I. ma through mz set local marks; backtick or apostrophe followed by the letter returns to the mark. Both forms currently restore the exact position.

v starts character selection; V starts line selection. Move to extend, o swaps endpoints, y copies rendered text, and Y copies Markdown source. In the composer, p/P paste the register. r from the transcript quotes the selection or current block into the draft. gx opens a URL; [u and ]u navigate URLs.

In composer Insert mode, Ctrl-V attaches an image from the host clipboard. Dropping a PNG, JPEG, GIF, or WebP file into the composer attaches its pasted path and inserts an inline [Image 1] marker at the cursor. You can type around the marker; Backspace or Delete beside it removes the image. Image-only messages are supported. Queued and failed messages retain their images in their message positions. The clipboard belongs to the machine running Vimex; over SSH, a dropped file path must be accessible on that machine.

Enter or za toggles the current fold. zo/zc open/close it. zR/zM open/close all folds, including diffs. Shift-Tab opens or closes all tool blocks from either pane without changing file diffs; its choice also applies to new tools. Tool calls start collapsed; file diffs start expanded.

## SESSIONS AND AGENTS

Space s or :sessions opens the picker and refreshes its session list, initially scoped to the current directory. Tab toggles all directories. The picker lists parent sessions; child agents remain available through agent navigation or an exact thread ID. j/k or arrows navigate; i or / enters search. Escape leaves search, then closes the picker. :sessions ID opens an exact thread.

:rename NAME renames the focused session. Until renamed, the title is a short, single-line excerpt of the first message. :favorite toggles its favorite state; :favorite on/off sets it explicitly. :new [PATH] starts a session. :cwd [PATH] shows or changes its working directory.

Headers show PARENT for an original conversation with children or a side chat, CHILD for a delegated conversation, and SIDE for a side conversation. Standalone conversations have no role badge. Child breadcrumbs show Back to parent; side breadcrumbs show Focus parent.

Child assignments appear as compact foldable rows named for the child agent. Enter expands the assignment and any reported result; gc in transcript Normal mode opens that child's transcript, or a chooser scoped to the row when it has multiple children. Codex children that do not accept direct input can be read, with instructions sent through their parent. While a wait call is active, the parent activity reads Waiting for agents; its completion returns to Working without marking the children finished. Messages and follow-ups remain separate events.

ga opens the agent roster for the current root conversation, grouped into Running and Finished. It includes nested spawned children and excludes /side conversations. h hides or shows finished agents; Enter opens the selected transcript. [a and ]a cycle the immediate family. Backslash returns to the immediate parent. Ctrl-O/I also navigate session and agent visits.

f or :fork opens confirmation to fork through the selected completed turn.

## SIDE CHATS

/side or :side opens a fork alongside the parent without sending a message. An optional question starts the side conversation. Codex inherits parent context, but the visible side transcript contains only new side messages.

Ctrl-H focuses main; Ctrl-L focuses side. Ctrl-W h/l are alternatives. Ctrl-W w cycles panes. Ctrl-W | maximizes/restores; Ctrl-W = restores the split. Narrow terminals stack panes; short terminals show one pane at a time.

:side close or Ctrl-W c hides the pane while its agent continues. /side reopens the same conversation. :side quit or Ctrl-W q stops and retires it; the next /side creates a fresh fork.

:side refresh sends a bounded snapshot of recent parent activity. :side quote appends selected side text or the current block to the parent draft without sending it.

## COMMANDS AND MODEL SETTINGS

: enters Command mode in the bottom bar. Tab completes; arrows choose; Ctrl-P/N recalls history; Enter executes; Escape cancels. A leading / in an Insert-mode composer opens slash commands. Use // to send a literal slash-leading message.

:model opens a model and reasoning-effort picker. :model MODEL EFFORT sets both directly. :thinking [LEVEL] shows or sets reasoning effort.

:theme NAME sets UI colors. :syntax theme follows that palette; :syntax NAME chooses syntax colors separately. Choices include ember-tide, nord, gruvbox-material, kanagawa, tokyo-night, catppuccin-mocha, rose-pine-dawn, everforest, solarized-light, solarized-dark, one-dark, and dracula.

:approvals and :questions open pending agent requests. :stop interrupts. :restart reconnects the Codex server and restores sessions and drafts; uncertain submissions require explicit retry. It does not reload Vimex's own program code. :q exits.

:help shows the compact reference. :help COMMAND shows command usage. :manual, :man, :help manual, and /manual open this guide offline. In the manual, j/k scroll, Ctrl-D/U move half a page, gg/G go to the start/end, and Escape closes it without changing the draft.

## GOALS AND COMPACTION

:goal or /goal shows the current goal. :goal OBJECTIVE sets one; :goal --budget TOKENS OBJECTIVE sets an explicit token budget. pause, resume, complete, and clear manage its lifecycle. Use :goal set pause to set the literal objective 'pause'. Codex owns continuation; pausing a goal does not interrupt an already running turn.

:compact or /compact asks Codex to compact context while idle. The Compacting indicator follows server events; sending is paused until completion and drafts are preserved.

## FILES AND ENVIRONMENT

$XDG_CONFIG_HOME/vimex/config.json stores configuration, defaulting to ~/.config/vimex/config.json. --config overrides this path. Unknown configuration keys are rejected.

$XDG_STATE_HOME/vimex stores local drafts, view state, marks, favorites, and side associations, defaulting to ~/.local/state/vimex. Codex remains the source of truth for conversation history.

codexExecutable selects the Codex executable. NO_COLOR requests reduced color. Optional Herdr integration activates in a recognized Herdr pane.

## TROUBLESHOOTING

If Codex is unavailable, check PATH, codexExecutable, and codex login. If the server disconnects, use :restart. To load a newer Vimex build, exit and relaunch Vimex itself.

Terminals may conflate Ctrl-I with Tab or Ctrl-H with Backspace. Vimex recognizes legacy BS as Ctrl-H for side navigation; DEL remains Backspace. Ctrl-W h is an alternative. Modified Enter requires terminal support.

## SEE ALSO

codex(1), bun(1)

Repository guides: docs/install.md, docs/configuration.md, docs/keys.md, docs/themes.md, docs/side-chats.md, docs/goals.md, and docs/troubleshooting.md.

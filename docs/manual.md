# Vimex manual

<!-- man-date: September 18, 2026 -->

## NAME

vimex - a full-screen, Vim-operated interface for Codex

## SYNOPSIS

vimex [--cwd PATH] [--thread ID] [--model NAME] [--config PATH]

vimex --demo

vimex --help | --version

Vimex currently runs from a source checkout. Use bun run start followed by the options above. A global executable, Homebrew package, curl installer, and upgrade subcommand are planned, not yet published.

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

## MODES AND COMPOSING

Normal, Insert, Visual, and Command modes follow Vim conventions. Focus and mode are separate: either the composer or transcript can have focus.

i enters Insert. Enter sends by default; Shift-Enter inserts a newline when supported by the terminal. Ctrl-Enter steers an active turn or sends when idle. Escape leaves editing or closes an overlay; from Normal mode, it interrupts the active turn. Ctrl-C also interrupts.

Up/Ctrl-K focuses the lowest visible transcript content row. Down/Ctrl-J focuses the composer. These bindings respect local menu and completion navigation.

Space e expands or collapses the composer. Expanded drafts can scroll internally. Space r opens rename with the old name shown as a hint and an empty replacement ready to type.

## TRANSCRIPT NAVIGATION

h/j/k/l move the text cursor; w/b/e move by word. 0 and $ move to line boundaries. gg goes to the start. G or t resumes following the tail. :tail and :follow do the same.

Ctrl-E/Y scroll down/up one row; Ctrl-D/U scroll half a viewport; Ctrl-F/B scroll a viewport in the transcript. Ctrl-E/Y/D/U also scroll the transcript while the composer keeps focus. Mouse-wheel scrolling preserves focus and detaches tail following.

{ and } move by semantic block. [[ and ]] move by message. / and ? search from Normal mode in either pane; n/N repeat the search.

s opens Flash in Normal mode. Ctrl-G opens Flash from either pane, including composer Insert. Type visible text and then a label to jump. Escape cancels.

Ctrl-O moves backward through jumps and session visits; Ctrl-I moves forward. Legacy terminals may send Tab for Ctrl-I. ma through mz set local marks; backtick or apostrophe followed by the letter returns to the mark. Both forms currently restore the exact position.

v starts character selection; V starts line selection. Move to extend, o swaps endpoints, y copies rendered text, and Y copies Markdown source. In the composer, p/P paste the register. r from the transcript quotes the selection or current block into the draft. gx opens a URL; [u and ]u navigate URLs.

Enter or za toggles the current fold. zo/zc open/close it. zR/zM open/close all folds. Shift-Tab toggles all folds from either pane. Tool calls start collapsed; file diffs start expanded.

## SESSIONS AND AGENTS

Space s or :sessions opens the picker, initially scoped to the current directory. Tab toggles all sessions. j/k or arrows navigate; i or / enters search. Escape leaves search, then closes the picker. :sessions ID opens an exact thread.

:rename NAME renames the focused session. :favorite toggles its favorite state; :favorite on/off sets it explicitly. :new [PATH] starts a session. :cwd [PATH] shows or changes its working directory.

ga opens the agent picker. [a and ]a cycle the immediate family. Backslash returns to the immediate parent. Ctrl-O/I also navigate session and agent visits.

f or :fork opens confirmation to fork through the selected completed turn.

## SIDE CHATS

/side or :side opens a fork alongside the parent without sending a message. An optional question starts the side conversation. Codex inherits parent context, but the visible side transcript contains only new side messages.

Ctrl-H focuses main; Ctrl-L focuses side. Ctrl-W h/l are alternatives. Ctrl-W w cycles panes. Ctrl-W | maximizes/restores; Ctrl-W = restores the split. Narrow terminals stack panes; short terminals show one pane at a time.

:side close or Ctrl-W c hides the pane while its agent continues. /side reopens the same conversation. :side quit or Ctrl-W q stops and retires it; the next /side creates a fresh fork.

:side refresh sends a bounded snapshot of recent parent activity. :side quote appends selected side text or the current block to the parent draft without sending it.

## COMMANDS AND MODEL SETTINGS

: enters Command mode in the bottom bar. Tab completes; arrows choose; Ctrl-P/N recalls history; Enter executes; Escape cancels. A leading / in an Insert-mode composer opens slash commands. Use // to send a literal slash-leading message.

:model opens a model and reasoning-effort picker. :model MODEL EFFORT sets both directly. :thinking [LEVEL] shows or sets reasoning effort.

:theme NAME sets UI colors. :syntax theme follows that palette; :syntax NAME chooses syntax colors separately. Choices include ember-tide, nord, gruvbox-material, kanagawa, tokyo-night, and catppuccin-mocha.

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

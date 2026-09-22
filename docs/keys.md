# Keyboard reference

Vimex has four modes: Normal, Insert, Visual, and Command. Transcript/composer focus is independent from the mode. Counts work for transcript motions and the supported composer motions and edits.

Press `:help` for the compact in-app reference, or `:manual` (`:man`, `/manual`, `:help manual`) for the offline user manual.

## Focus and global actions

| Key                              | Action                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` / `Ctrl-k` (also `Ctrl-w k`) | Focus the lowest visible transcript content row when leaving the composer, preserving scroll position. Available in every mode; leaving Insert, Visual, or Command for the transcript returns to Normal mode. |
| `↓` / `Ctrl-j` (also `Ctrl-w j`) | Focus composer. Available in every mode; leaving Visual or Command returns to Normal mode.                                                                                                                    |
| `Ctrl-c`                         | Interrupt the active Codex turn.                                                                                                                                                                              |
| `Esc`                            | Dismiss the active overlay or return to Normal mode; from Normal mode, interrupt the active Codex turn and focus the transcript. Drafts are preserved.                                                        |
| `:`                              | Enter Command mode.                                                                                                                                                                                           |

## Transcript in Normal or Visual mode

| Key                          | Action                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `h j k l`                    | Move the logical transcript cursor.                                               |
| `w/b/e`, `W/B/E`             | Move by word or whitespace-delimited WORD; counts and Visual extension supported. |
| `0`, `$`, `^`                | Start of visual line, end of visual line, first content.                          |
| `gg`, `G`                    | First item; last item and resume tail following.                                  |
| `Ctrl-e`, `Ctrl-y`           | Scroll down/up one line without changing mode.                                    |
| `Ctrl-d`, `Ctrl-u`           | Scroll down/up half a viewport.                                                   |
| `Ctrl-f`, `Ctrl-b`           | Scroll down/up one viewport.                                                      |
| `{`, `}` (Shift-[ / Shift-]) | Previous/next semantic block.                                                     |
| `[[`, `]]`                   | Previous/next message.                                                            |
| `[u`, `]u`                   | Previous/next URL.                                                                |
| `/`, `?`                     | Search transcript forward/backward; also available from composer Normal mode.     |
| `n`, `N`                     | Next/previous search match.                                                       |
| `r`                          | Quote the selected text or current semantic block into the composer.              |
| `gx`                         | Open the URL at the cursor, or show a URL chooser when needed.                    |
| `za`, `zo`, `zc`             | Toggle, open, or close the current fold.                                          |
| `zR`, `zM`                   | Open or close all folds.                                                          |
| `v`, `V`                     | Begin character or line Visual selection.                                         |
| `f`                          | Request a fork through the selected completed turn. A confirmation overlay opens. |

Typing a numeric prefix repeats supported motions, up to four digits.

The transcript shows a precise text cursor in Normal and Visual modes. Move first in Normal, press `v` to anchor a selection, extend it with motions, then `y` to copy. Up/Down and Ctrl-K/J change focus without scrolling. Menus retain arrow navigation; Command mode uses arrows for completion choices and Ctrl-P/N for history. Global Ctrl-J/K → Down/Up remappings therefore work without application-specific exceptions.

## Visual mode

| Key                       | Action                                      |
| ------------------------- | ------------------------------------------- |
| Normal transcript motions | Extend the selection.                       |
| `o`                       | Swap selection anchor and head.             |
| `y`                       | Copy rendered plain text.                   |
| `Y`                       | Copy canonical Markdown source.             |
| `gx`                      | Open a URL in the selection/cursor context. |
| `Esc`                     | Clear selection and return to Normal mode.  |

## Composer

Use Down or `Ctrl-j` to focus the composer. While composing in Normal, Insert, or Visual mode, `Ctrl-e/y` scroll the transcript one line and `Ctrl-d/u` scroll half a page without changing composer focus, text, cursor, or selection. `i` enters Insert mode. Normal mode supports `h/j/k/l`, `w/b/e`, `0/^/$`, `gg/G`, counts, `x`, `dd`, `D`, `C`, `p/P`, `o/O`, `i/a/I/A`, `v`, `u`, `Ctrl-r`, and `R` to retry the first failed outgoing message. Composer Visual mode supports motions and `y`.

In Insert mode:

| Key           | Action                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `Esc`         | Return to Normal mode.                                                              |
| `Enter`       | Submit by default; inserts a newline when `insertEnter` is `newline`.               |
| `Shift+Enter` | Insert a newline. This depends on the terminal reporting modified Enter distinctly. |
| `Ctrl+Enter`  | Steer the active turn, or send when idle.                                           |

Command entry replaces the bottom status strip while leaving the composer and transcript in place. Enter executes; Escape restores the status strip.

In transcript Normal mode, Enter toggles the current foldable block. Shift-Tab toggles all foldable blocks from either transcript or composer without changing focus or the draft: if any block is collapsed it expands all; otherwise it collapses all. Command completion and overlays keep their local Tab behavior. `zR` and `zM` retain their uppercase Vim meanings. Current-block `za`/`zo`/`zc` operate only on foldable transcript blocks, in Normal or Visual mode; they do not change composer text or fold ordinary messages. Visual selections remain intact when toggling folds.

## Views and overlays

| Key or command                                | Action                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Space s`, `:sessions`                        | Search and switch sessions.                                                        |
| `a` from transcript Normal mode, `:approvals` | Open pending approvals. In composer Normal mode, `a` keeps its Vim append meaning. |
| `gc` (transcript Normal mode)                 | Open the child conversation referenced by the current row.                         |
| `ga`, `:agents`                               | Open parent/child agent navigation.                                                |
| `:questions`                                  | Open pending structured questions.                                                 |
| `:parent`                                     | Return to the parent agent thread.                                                 |
| `:manual`                                     | Read the scrollable offline user manual.                                           |
| `:help`                                       | Open the scrollable key and command reference.                                     |

Normal mode also provides a Space leader vocabulary: `Space s` opens sessions, `Space a` opens approvals, `Space q` opens questions, and `Space ?` opens help. The second key is a leader token rather than an independent fallback action.

In menus, use `j/k`, Up/Down, or `Ctrl-p`/`Ctrl-n` to choose, and Enter to activate. Session menus use `j/k` in Normal mode. Press `i` or `/` to enter Insert search; other text starts search automatically. While searching, `j/k` type literal letters. Escape returns to Normal navigation, then Escape again closes. Rename inputs also keep literal text keys. Option-only questions accept `j/k`; free-text questions preserve those letters. Approval choices can be selected with `1` through `9`.

Typing `/` at the beginning of an Insert-mode draft opens the command drawer above the composer. Up/Down or `Ctrl-p`/`Ctrl-n` selects, Tab completes, and Enter runs the selected command. `j/k` remain query letters because this is Insert mode. Escape dismisses the drawer into Normal mode. Unknown commands and invalid arguments remain editable with inline feedback. Use `//text` to send a literal slash-leading prompt (`/text`). Model IDs, thinking levels, theme choices, and session IDs complete from the same vocabulary as Ex. Tab adds a trailing space so the next argument can be completed. `submit` is an Ex action because the composer contains the slash command itself.

## Command mode

Enter `:` to open command completion above the bottom command bar. Up/Down selects a suggestion, Tab completes names or supported arguments, and Ctrl-P/N recalls command history. Enter executes the typed command or selected completion. Esc cancels and restores the previous focus without changing the composer draft.

| Command                                            | Action                                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:q`                                               | Quit.                                                                                                                                                                   |
| `:help [COMMAND]`                                  | Browse keys and commands, or show usage for one command.                                                                                                                |
| `:sessions [ID]`                                   | Open the session picker or resume an exact thread ID, including one absent from the current list.                                                                       |
| `:favorite [on\|off]`                              | Toggle the active session favorite, or set it explicitly.                                                                                                               |
| `:follow`, `:tail`                                 | Return to the live transcript tail.                                                                                                                                     |
| `:model [NAME] [EFFORT]`                           | Open the model and thinking-level picker, or set both directly. Tab completes model IDs and their supported efforts, leaving the cursor ready for the next argument.    |
| `:thinking [LEVEL]`                                | List supported effort levels or change effort.                                                                                                                          |
| `:cwd [PATH]`                                      | Show or change the active thread working directory. Relative paths resolve from its current directory.                                                                  |
| `:new [PATH]`                                      | Start a thread, optionally in another directory.                                                                                                                        |
| `:rename NAME`                                     | Rename the active thread.                                                                                                                                               |
| `:approve`, `:reject`                              | Use a matching quick decision for the first pending approval; open `:approvals` when a choice is ambiguous.                                                             |
| `:stop`                                            | Interrupt the active turn.                                                                                                                                              |
| `:compact`, `/compact`                             | Compact the focused session context while idle. The Compacting animation follows server lifecycle events; sending is paused and drafts are preserved until it finishes. |
| `:restart`                                         | Restart the Codex app server and rehydrate the active thread.                                                                                                           |
| `:fork`                                            | Open fork confirmation at the current message context.                                                                                                                  |
| `:fold`, `:unfold`                                 | Fold or unfold all foldable transcript items.                                                                                                                           |
| `:yank [text\|markdown]`, `:copy [text\|markdown]` | Copy the selection or current transcript block as rendered text or exact source, also populating the composer register.                                                 |
| `:open [URL]`                                      | Open a supplied URL or the current transcript URL.                                                                                                                      |
| `:theme NAME`                                      | Select and persist a UI theme.                                                                                                                                          |
| `:syntax NAME`                                     | Select and persist a syntax theme; `theme` follows the UI palette.                                                                                                      |
| `:submit [queue\|steer]`                           | Send the composer draft using the configured default or an explicit queue/steer intent.                                                                                 |
| `:insert`, `:normal`, `:visual`                    | Enter a mode; Visual initializes a transcript selection.                                                                                                                |

Mouse-wheel scrolling moves the transcript by precise terminal rows, preserves composer focus and both text cursors, and detaches from the streaming tail. Reaching the bottom with the wheel keeps the viewport detached; use the explicit follow command to resume following.

## Flash jumps, jumplist, and marks

- `s` in either pane’s Normal mode (and transcript Visual mode) opens Flash; `Ctrl-g` opens it from either pane, including composer Insert mode. Type visible text, then a highlighted label. Labels never consume a valid continuation of the query. Enter chooses the first labeled match; Tab cycles label pages. Escape cancels and restores focus/mode without changing drafts. Resize or session changes cancel the prompt.
- Matching is literal and case-insensitive unless the query contains uppercase. Targets are visible rendered text, excluding hidden folded content. A Visual transcript jump extends selection. Source text is not modified by labels.
- `Ctrl-o` (letter O) goes backward through significant jumps and session/agent visits; `Ctrl-i` (letter I) goes forward. Each visit restores its cursor and reading viewport without replacing drafts. Cross-session history lasts for the current application run; session-local marks and jumps remain persisted. On terminals advertising Kitty keyboard support they are distinct from Tab. Legacy terminals encode Ctrl-I as Tab, so Tab is accepted as a fallback outside command/slash completion. Enter toggles the current fold; Shift-Tab still toggles all.
- `ma` through `mz` set session-local named marks at the transcript cursor. Backtick+a or apostrophe+a returns to mark a's exact text position. Both forms currently use exact positions (apostrophe is not linewise). Marks and the bounded jumplist survive session resume; unavailable targets are discarded.

Inspired by [flash.nvim](https://github.com/folke/flash.nvim)'s labeled search. This implements transcript jumps, not Neovim Treesitter selection or operator-pending remote actions.

## Agent navigation

From either pane in Normal mode, `ga` opens the agent picker, `[a` and `]a` cycle the immediate parent and its children, and `\` returns to the immediate parent. Root sessions cycle their direct children. Existing `[[`/`]]` message motions remain available. The original session shows PARENT once it has children or a side chat. Delegated sessions show CHILD and a parent breadcrumb with `\` Back to parent. Side conversations show SIDE with `\` Focus parent. Standalone sessions have no role badge; Ctrl-O/Ctrl-I revisit parent, sibling, and local transcript locations in chronological order.

Child assignments appear as foldable CHILD rows with a task preview and reported progress. Enter expands the assignment and reported result; `gc` opens the child (or the picker for multiple targets). Messages and follow-ups remain separate transcript events.

## Side chat

`/side [question]` and `:side [question]` open a forked side conversation alongside the parent. With no question, they reopen the same side conversation, preserving its draft and transcript. The parent stays visible and can keep working. Context begins at the fork point; `:side refresh` supplies newer parent activity to the existing side conversation.

| Key or command                            | Action                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Ctrl-h` / `Ctrl-l`                       | Focus main / side directly.                                                                                             |
| `Ctrl-w h` / `Ctrl-w l`                   | Alternate main / side focus keys.                                                                                       |
| `Ctrl-w w`                                | Cycle visible panes.                                                                                                    |
| `Ctrl-w \|`                               | Maximize the focused pane; repeat to restore the split.                                                                 |
| `Ctrl-w =`                                | Restore default pane sizes.                                                                                             |
| `\` in side Normal mode                   | Focus the immediate parent.                                                                                             |
| `:side close` or `/side close`            | Hide the side pane. Its agent can continue working; `/side` reopens the same conversation.                              |
| `:side quit` or `/side quit`              | Stop and retire the side agent. It cannot be reopened as that side conversation; the next `/side` creates a fresh fork. |
| `:side refresh`                           | Supply the latest parent activity to the side conversation.                                                             |
| `:side maximize`                          | Toggle maximization of the focused pane.                                                                                |
| `:side focus parent` / `:side focus side` | Focus a pane explicitly.                                                                                                |

Up/Down and Ctrl-K/J continue to switch between composer and transcript within the focused pane. Escape retains mode cancellation and turn interruption; it does not close the side pane. Ctrl-O/Ctrl-I continue to navigate visit history.

In Normal mode, `Space r` opens `:rename` with an empty name ready to type and the current title shown as a hint. `:rename New title` also renames directly. `t` follows the focused transcript tail from either composer or transcript without changing the draft. Insert mode still types a literal `t`.

Side-pane window shortcuts: `Ctrl-W c` hides the side pane and keeps its agent running; `Ctrl-W q` quits and retires that side session. A later `/side` reopens a hidden side session, or creates a new one after quit.

`Space e` in Normal mode expands/collapses the composer. It shows the draft up to the available pane height, then scrolls internally. Session picker opens in **This directory** scope; Tab toggles **All sessions** while preserving the search query. Favorites still obey the current scope; use All sessions or `:sessions ID` to open a known thread outside the current directory.

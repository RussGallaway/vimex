# Keyboard reference

Vimex has four modes: Normal, Insert, Visual, and Command. Transcript/composer focus is independent from the mode. Counts work for transcript motions and the supported composer motions and edits.

Press `:help` for the compact in-app reference.

## Focus and global actions

| Key | Action |
| --- | --- |
| `↑` / `Ctrl-k` (also `Ctrl-w k`) | Focus transcript. Available in every mode; leaving Insert, Visual, or Command for the transcript returns to Normal mode. |
| `↓` / `Ctrl-j` (also `Ctrl-w j`) | Focus composer. Available in every mode; leaving Visual or Command returns to Normal mode. |
| `Ctrl-c` | Interrupt the active Codex turn. |
| `Esc` | Return to Normal mode; from Normal mode, focus the transcript. |
| `:` | Enter Command mode. |

## Transcript in Normal or Visual mode

| Key | Action |
| --- | --- |
| `h j k l` | Move the logical transcript cursor. |
| `w/b/e`, `W/B/E` | Move by word or whitespace-delimited WORD; counts and Visual extension supported. |
| `0`, `$`, `^` | Start of visual line, end of visual line, first content. |
| `gg`, `G` | First item; last item and resume tail following. |
| `Ctrl-e`, `Ctrl-y` | Scroll down/up one line without changing mode. |
| `Ctrl-d`, `Ctrl-u` | Scroll down/up half a viewport. |
| `Ctrl-f`, `Ctrl-b` | Scroll down/up one viewport. |
| `{`, `}` (Shift-[ / Shift-]) | Previous/next semantic block. |
| `[[`, `]]` | Previous/next message. |
| `[u`, `]u` | Previous/next URL. |
| `/`, `?` | Search forward/backward. |
| `n`, `N` | Next/previous search match. |
| `r` | Quote the selected text or current semantic block into the composer. |
| `gx` | Open the URL at the cursor, or show a URL chooser when needed. |
| `za`, `zo`, `zc` | Toggle, open, or close the current fold. |
| `zR`, `zM` | Open or close all folds. |
| `v`, `V` | Begin character or line Visual selection. |
| `f` | Request a fork through the selected completed turn. A confirmation overlay opens. |

Typing a numeric prefix repeats supported motions, up to four digits.

The transcript shows a precise text cursor in Normal and Visual modes. Move first in Normal, press `v` to anchor a selection, extend it with motions, then `y` to copy. Up/Down and Ctrl-K/J change focus without scrolling. Menus retain arrow navigation; Command mode uses arrows for completion choices and Ctrl-P/N for history. Global Ctrl-J/K → Down/Up remappings therefore work without application-specific exceptions.

## Visual mode

| Key | Action |
| --- | --- |
| Normal transcript motions | Extend the selection. |
| `o` | Swap selection anchor and head. |
| `y` | Copy rendered plain text. |
| `Y` | Copy canonical Markdown source. |
| `gx` | Open a URL in the selection/cursor context. |
| `Esc` | Clear selection and return to Normal mode. |

## Composer

Use Down or `Ctrl-j` to focus the composer. While composing in Normal, Insert, or Visual mode, `Ctrl-e/y` scroll the transcript one line and `Ctrl-d/u` scroll half a page without changing composer focus, text, cursor, or selection. `i` enters Insert mode. Normal mode supports `h/j/k/l`, `w/b/e`, `0/^/$`, `gg/G`, counts, `x`, `dd`, `D`, `C`, `p/P`, `o/O`, `i/a/I/A`, `v`, `u`, `Ctrl-r`, and `R` to retry the first failed outgoing message. Composer Visual mode supports motions and `y`.

In Insert mode:

| Key | Action |
| --- | --- |
| `Esc` | Return to Normal mode. |
| `Enter` | Submit by default; inserts a newline when `insertEnter` is `newline`. |
| `Shift+Enter` | Insert a newline. This depends on the terminal reporting modified Enter distinctly. |
| `Ctrl+Enter` | Steer the active turn, or send when idle. |

Command entry replaces the bottom status strip while leaving the composer and transcript in place. Enter executes; Escape restores the status strip.

In the transcript, Tab toggles the current foldable block. Shift-Tab toggles all foldable blocks from either transcript or composer without changing focus or the draft: if any block is collapsed it expands all; otherwise it collapses all. Command completion and overlays keep their local Tab behavior. `zR` and `zM` retain their uppercase Vim meanings.

## Views and overlays

| Key or command | Action |
| --- | --- |
| `s`, `:sessions` | Search and switch sessions. |
| `a` from transcript Normal mode, `:approvals` | Open pending approvals. In composer Normal mode, `a` keeps its Vim append meaning. |
| `ga`, `:agents` | Open parent/child agent navigation. |
| `:questions` | Open pending structured questions. |
| `:parent` | Return to the parent agent thread. |
| `:help` | Open the compact key reference. |

Normal mode also provides a Space leader vocabulary: `Space s` opens sessions, `Space a` opens approvals, `Space q` opens questions, and `Space ?` opens help. The second key is a leader token rather than an independent fallback action.

In menus, use `j/k`, Up/Down, or `Ctrl-p`/`Ctrl-n` to choose, and Enter to activate. Session menus use `j/k` in Normal mode. Press `i` or `/` to enter Insert search; other text starts search automatically. While searching, `j/k` type literal letters. Escape returns to Normal navigation, then Escape again closes. Rename inputs also keep literal text keys. Option-only questions accept `j/k`; free-text questions preserve those letters. Approval choices can be selected with `1` through `9`.

Typing `/` at the beginning of an Insert-mode draft opens the command drawer above the composer. Up/Down or `Ctrl-p`/`Ctrl-n` selects, Tab completes, and Enter runs the selected command. `j/k` remain query letters because this is Insert mode. Escape dismisses the drawer into Normal mode. Unknown commands remain editable rather than executing another command.

## Command mode

Enter `:` to open command completion above the bottom command bar. Up/Down selects a suggestion, Tab completes names or supported arguments, and Ctrl-P/N recalls command history. Enter executes the typed command or selected completion. Esc cancels and restores the previous focus without changing the composer draft.

| Command | Action |
| --- | --- |
| `:q` | Quit. |
| `:model [NAME] [EFFORT]` | Open the model and thinking-level picker, or set both directly. Tab completes model IDs and their supported efforts, leaving the cursor ready for the next argument. |
| `:thinking [LEVEL]` | List supported effort levels or change effort. |
| `:cwd [PATH]` | Show or change the active thread working directory. Relative paths resolve from its current directory. |
| `:new [PATH]` | Start a thread, optionally in another directory. |
| `:rename NAME` | Rename the active thread. |
| `:approve`, `:reject` | Use a matching quick decision for the first pending approval; open `:approvals` when a choice is ambiguous. |
| `:stop` | Interrupt the active turn. |
| `:restart` | Restart the Codex app server and rehydrate the active thread. |
| `:fork` | Open fork confirmation at the current message context. |
| `:fold`, `:unfold` | Fold or unfold all foldable transcript items. |
| `:yank [text\|markdown]` | Copy selection/current context as rendered text or Markdown source. |
| `:open [URL]` | Open a supplied URL or the current transcript URL. |
| `:theme NAME` | Select and persist a UI theme. |
| `:syntax NAME` | Select and persist a syntax theme; `theme` follows the UI palette. |
| `:submit`, `:insert`, `:normal`, `:visual` | Invoke the corresponding action or mode. |

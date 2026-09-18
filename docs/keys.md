# Keyboard reference

Vimex has four modes: Normal, Insert, Visual, and Command. Transcript/composer focus is independent from the mode. Counts work for transcript motions and the supported composer motions and edits.

Press `:help` for the compact in-app reference.

## Focus and global actions

| Key | Action |
| --- | --- |
| `Ctrl-w k` | Focus transcript. Available in every mode; leaving Insert, Visual, or Command for the transcript returns to Normal mode. |
| `Ctrl-w j` | Focus composer. Available in every mode; leaving Visual or Command returns to Normal mode. |
| `Ctrl-c` | Interrupt the active Codex turn. |
| `Esc` | Return to Normal mode; from Normal mode, focus the transcript. |
| `:` | Enter Command mode. |

## Transcript in Normal or Visual mode

| Key | Action |
| --- | --- |
| `h j k l` | Move the logical transcript cursor. |
| `0`, `$`, `^` | Start of visual line, end of visual line, first content. |
| `gg`, `G` | First item; last item and resume tail following. |
| `Ctrl-e`, `Ctrl-y` | Scroll down/up one line without changing mode. |
| `Ctrl-d`, `Ctrl-u` | Scroll down/up half a viewport. |
| `Ctrl-f`, `Ctrl-b` | Scroll down/up one viewport. |
| `{`, `}` | Previous/next semantic block. |
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

Use `Ctrl-w j` to focus the composer. `i` enters Insert mode. Normal mode supports `h/j/k/l`, `w/b/e`, `0/^/$`, `gg/G`, counts, `x`, `dd`, `D`, `C`, `p/P`, `o/O`, `i/a/I/A`, `v`, `u`, `Ctrl-r`, and `R` to retry the first failed outgoing message. Composer Visual mode supports motions and `y`.

In Insert mode:

| Key | Action |
| --- | --- |
| `Esc` | Return to Normal mode. |
| `Enter` | Submit by default; inserts a newline when `insertEnter` is `newline`. |
| `Shift+Enter` | Insert a newline. This depends on the terminal reporting modified Enter distinctly. |
| `Ctrl+Enter` | Steer the active turn, or send when idle. |

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

In an overlay, use Up/Down or `Ctrl-p`/`Ctrl-n`, Enter to activate, and Esc or `?` to close. Most overlays also accept `j/k`; searchable session and question inputs reserve text keys. Approval choices can be selected with `1` through `9`.

## Command mode

Enter `:` and type a command. Up/Down recalls command history and Tab completes command names. Esc cancels.

| Command | Action |
| --- | --- |
| `:q` | Quit. |
| `:model [NAME]` | List models or change the active thread model. |
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

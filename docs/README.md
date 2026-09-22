# Vimex documentation

Start with [install and run](install.md), then the [user manual](manual.md).

| Guide                                   | Purpose                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| [User manual](manual.md)                | Offline guide, also available through `:manual` and as `vimex(1)` |
| [Keyboard reference](keys.md)           | Detailed modes, motions, focus, selection, and commands           |
| [Configuration](configuration.md)       | Settings, paths, and overrides                                    |
| [Themes](themes.md)                     | UI and syntax palettes                                            |
| [Side chats](side-chats.md)             | Forked sidebar lifecycle and navigation                           |
| [Goals](goals.md)                       | Native Codex goals and budgets                                    |
| [Terminal support](terminal-support.md) | Key encoding and terminal behavior                                |
| [Troubleshooting](troubleshooting.md)   | Runtime and display recovery                                      |
| [Homebrew](homebrew.md)                 | Formulae, taps, bottles, and core admission                       |
| [CLI topology](cli-architecture.md)     | Proposed command dispatch and distribution boundaries             |
| [Release plan](releasing.md)            | Proposed global distribution, updates, and automation             |

## In-app and Unix manuals

`:help` is the quick reference. `:manual`, `:man`, `:help manual`, and `/manual` open the longer manual without leaving Vimex or accessing the network. Scroll with j/k, Ctrl-D/U, or the mouse; gg/G go to the start/end. Escape returns to the session. The manual is read-only and does not alter the draft.

From a source checkout, view the generated Unix manual with:

```sh
man ./docs/man/vimex.1
```

`man vimex` will work once a distribution installs the page under its `share/man/man1` directory. No global installer is published yet.

## Maintaining documentation

Edit `docs/manual.md` for manual content. It uses level-two headings and prose paragraphs. Update its `man-date` comment when changing the manual. Generate both the roff page and embedded UI content:

```sh
bun run docs:generate
bun run docs:check
```

Commit both generated files. `bun run check` verifies they match the source. The UI bundles its copy, so the installed application will not depend on a checkout or a system `man` command. Keep the detailed topic guides linked above in sync when behavior changes.

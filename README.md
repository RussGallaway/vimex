# Vimex

Vimex is a full-screen, Vim-operated terminal interface for the Codex app server, built with OpenTUI React. Vimex owns presentation, navigation, drafts, and local preferences; Codex owns execution, permissions, and conversation history.

The fixed composer stays available while responses stream, so you can read elsewhere in the transcript and prepare the next message without losing your place. Normal, Insert, Visual, and Command modes provide a familiar Vim model for composing, navigating, selecting, folding tool calls, following links, switching sessions, and moving between parent and subagent conversations.

Vimex is currently an early `0.1.x` project. The default dark theme is **Ember Tide**, with Nord, Gruvbox Material, Kanagawa, Tokyo Night, and Catppuccin Mocha included.

## Install

Live sessions require the Codex CLI to be installed and authenticated:

```sh
codex login
```

### Homebrew

Vimex keeps its Homebrew formula in this repository:

```sh
brew tap russgallaway/vimex https://github.com/RussGallaway/vimex.git
brew install russgallaway/vimex/vimex
```

Upgrade later with either command:

```sh
brew upgrade vimex
vimex upgrade
```

### Curl installer

The direct installer uses a user-owned prefix, verifies the release checksum, and does not require `sudo`:

```sh
curl -fsSL https://github.com/RussGallaway/vimex/releases/latest/download/install.sh | sh
```

It installs the launcher under `~/.local/bin` by default. Ensure that directory is on `PATH`. Direct installations can be upgraded with `vimex update` or `vimex upgrade`.

See [installation](docs/install.md) for explicit versions, custom install directories, source builds, bundled manual locations, update ownership, and uninstall instructions.

## Use

Open Vimex in the current project:

```sh
vimex
```

Useful entry points include:

```sh
vimex /path/to/project
vimex resume                 # choose an existing session in this directory
vimex resume --last          # resume the latest session in this directory
vimex resume THREAD_ID
vimex doctor                 # check configuration and local dependencies
```

Inside Vimex, `i` enters Insert mode and `Esc` returns to Normal mode. `Enter` submits from Insert mode, `:` opens command mode, `/` searches from Normal mode or opens slash commands from the composer, and `Space ?` opens help. Use `:manual` for the complete offline guide.

The transcript supports Vim motion, Visual selection and yanking, Flash-style jumps, marks and jump history, mouse scrolling, collapsible tools, expanded diffs, Markdown, syntax highlighting, sessions, subagents, and side chats. See the [keyboard reference](docs/keys.md) and [user manual](docs/manual.md).

## Configure

Configuration lives at `$XDG_CONFIG_HOME/vimex/config.json`, defaulting to `~/.config/vimex/config.json`:

```json
{
  "version": 1,
  "theme": "ember-tide",
  "syntaxTheme": "theme",
  "insertEnter": "submit",
  "busySubmit": "queue",
  "foldTools": true,
  "composerMaxHeight": 0.33,
  "keybindings": {}
}
```

Use commands such as `:theme nord`, `:syntax theme`, and `:model MODEL EFFORT` for common runtime changes. Unknown configuration keys are rejected. See [configuration](docs/configuration.md), [themes](docs/themes.md), and [terminal support](docs/terminal-support.md) for the complete options and compatibility notes.

Optional Herdr integration adds full-tab launching, reporting, and external URL actions. See the [Herdr plugin](plugins/herdr/README.md).

## Develop and contribute

Source development requires Bun 1.3.6 or later:

```sh
git clone https://github.com/RussGallaway/vimex.git
cd vimex
bun install --frozen-lockfile
bun run start --demo
```

The offline demo needs no Codex credentials. Start a live source session with `bun run start`, and run the complete validation suite with:

```sh
bun run check
```

Vimex is a TypeScript monorepo with explicit domain and adapter boundaries. Read [CONTRIBUTING.md](CONTRIBUTING.md) before moving behavior between packages or submitting a pull request. Architecture, topology, release engineering, testing, and project documents are indexed in [docs/README.md](docs/README.md).

## License

[MIT](LICENSE). Bundled third-party assets retain their own licenses and notices.

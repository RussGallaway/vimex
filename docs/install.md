# Install and run

Vimex is currently distributed as source. The repository does not yet publish a standalone executable or registry package. The planned first release is 0.1.0; see [distribution and releases](releasing.md).

Use `:manual` inside Vimex or `man ./docs/man/vimex.1` from the checkout to read the offline manual.

## Requirements

- macOS or a Unix-like environment. Linux is a CI target, but a completed remote CI run has not yet been recorded in the project validation notes.
- [Bun](https://bun.sh/) 1.3.6 or later.
- Python 3 only if you want to run the real-PTY test suite.
- An installed and authenticated Codex CLI for live sessions. Vimex's generated protocol adapter targets Codex 0.154.0.

Authenticate before starting Vimex:

```sh
codex login
```

## Run from a checkout

```sh
git clone https://github.com/RussGallaway/vimex.git
cd vimex
bun install --frozen-lockfile
bun run start --cwd /path/to/project
```

The working directory defaults to the directory where Vimex is launched. Available options are:

```text
--cwd PATH       Working directory
--thread ID      Resume a Codex thread
--model NAME     Model for a new thread
--config PATH    Read an alternate JSON configuration
--demo           Run without Codex using a local streaming demonstration
-h, --help       Show CLI help
-V, --version    Show the Vimex version
```

Try the interface without credentials or network access:

```sh
bun run start --demo
```

Use `:q` to exit. Vimex restores the previous terminal screen when it exits normally, receives a handled termination signal, or encounters a handled runtime failure.

## Codex compatibility

Vimex starts `codex app-server --listen stdio://` itself. Set `codexExecutable` in the Vimex configuration when `codex` is not on `PATH` or when testing a pinned executable. Protocol compatibility outside the generated 0.154.0 schema is not claimed; review and regenerate the adapter when upgrading across incompatible Codex versions.

## Herdr

Herdr installation is optional. Follow the [plugin instructions](../plugins/herdr/README.md) to register Vimex as a full-tab pane and configure interceptable URL actions.

# Install and run

The CLI, native packaging, Homebrew formula, and curl installer are published for macOS and Linux on ARM64 and x64. Source execution and local bundles remain available for development. See [distribution and releases](releasing.md).

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

## CLI

```sh
vimex /path/to/project
vimex resume                 # existing sessions in the current directory
vimex resume --last          # most recently updated session here
vimex resume THREAD_ID
vimex doctor
vimex update                 # alias for upgrade
vimex upgrade --version 0.1.0
```

From a checkout, replace `vimex` with `bun run start`. Bare resume and --last report an error when the directory has no sessions; neither creates a thread. Doctor checks local dependencies and configuration without starting Codex conversations.

## Standalone bundles

```sh
bun run build
bun run package
```

The host-native bundle is under `dist/vimex-v0.1.0-PLATFORM-ARCH/`. Keep `vimex`, `assets`, and `share` together: parser workers, grammars, and native libraries are runtime dependencies. The executable needs neither Bun nor a source checkout. Linux targets glibc, not musl/Alpine. Man pages and third-party notices are included.

## Homebrew

Once the formula commit is available on GitHub, before the first release:

```sh
brew tap russgallaway/vimex https://github.com/RussGallaway/vimex.git
brew install --HEAD russgallaway/vimex/vimex
```

Omit --HEAD to install the current stable prebuilt bundle. Use `brew upgrade vimex`, `vimex update`, or `vimex upgrade` for Homebrew-owned updates. The formula installs `man vimex`. See [Homebrew details](homebrew.md).

## Direct installation

After the first release is published:

```sh
curl -fsSL https://github.com/RussGallaway/vimex/releases/latest/download/install.sh -o /tmp/vimex-install.sh
sh /tmp/vimex-install.sh
```

Read the downloaded script before running it if desired. An optional positional version selects a release: `sh /tmp/vimex-install.sh 0.1.0`. The default bundle root is `~/.local/share/vimex`, with a launcher in `~/.local/bin`; add that directory to PATH yourself. Absolute `VIMEX_INSTALL_ROOT` and `VIMEX_BIN_DIR` overrides are supported. Installation requires curl, tar, and sha256sum or shasum.

The installer checks SHA-256, rejects unsafe archive entries, and switches a managed current symlink atomically. `vimex upgrade` uses the same release artifact/checksum contract and preserves previous bundles. Explicit --version may downgrade; latest never does. Installs and upgrades share a lock. No silent updates run during a session. Homebrew files and unrelated existing executables are not overwritten.

For the direct bundle manual, use `man ~/.local/share/vimex/current/share/man/man1/vimex.1`, or `:manual` inside Vimex. To uninstall a default direct installation, remove its `~/.local/bin/vimex` symlink and `~/.local/share/vimex` bundle directory after checking they belong to Vimex. Configuration and conversation state are separate and remain intact.

## Codex compatibility

Vimex starts `codex app-server --listen stdio://` itself. Set `codexExecutable` in the Vimex configuration when `codex` is not on `PATH` or when testing a pinned executable. Protocol compatibility outside the generated 0.154.0 schema is not claimed; review and regenerate the adapter when upgrading across incompatible Codex versions.

## Herdr

Herdr installation is optional. Follow the [plugin instructions](../plugins/herdr/README.md) to register Vimex as a full-tab pane and configure interceptable URL actions.

# CLI architecture

Status: implemented. apps/cli/src/main.ts is the executable entry point; apps/tui/src/main.tsx remains a source-launch compatibility wrapper.

One executable should support launching the TUI and short-lived commands. Keep parsing and dispatch separate from session behavior and installation/update policy. Load OpenTUI only when launching the interactive application, so help, version, doctor, and upgrades do not initialize a renderer.

```text
apps/
  cli/src/
    main.ts                     # process arguments and exit status
    parse-command.ts            # typed command union; update aliases upgrade
    run-command.ts              # dispatch to injected capabilities
    composition-root.ts         # select concrete adapters; lazy TUI import
    help.ts                     # CLI usage
    launch-directory.ts         # validate and canonicalize working directory
    runtime-assets.ts           # compiled bundle asset root before TUI import
  tui/src/
    composition-root.ts         # interactive application assembly
    lifecycle.ts                # terminal ownership and cleanup
    main.tsx                    # temporary source-launch compatibility wrapper

packages/
  distribution/src/
    domain/
      release.ts                # version, channel, platform artifact
      installation.ts           # brew, direct, or source ownership
      upgrade-plan.ts           # choose target and permitted update method
    application/
      upgrade.ts                # shared use case for update and upgrade
      diagnose.ts               # structured doctor results
      distribution-ports.ts     # release catalog, installer, package manager
    index.ts
  platform-node/src/distribution/
    github-releases.ts          # release API, download, timeouts
    installation-receipt.ts     # installation provenance and paths
    homebrew.ts                 # delegate managed upgrades
    direct-installer.ts         # verify, stage, replace atomically
    diagnostics.ts             # OS, executable and runtime probes
  workbench/src/application/    # existing session orchestration
  codex-app-server/src/         # existing Codex integration
  ui-opentui-react/src/help/    # offline embedded manual

scripts/release/
  build.ts                     # executable plus native/parser assets
  package.ts                   # archives, man page and notices
  manifest.ts                  # verify archives and assemble checksums/catalog
  update-homebrew.ts           # formula release URL/checksum update
Formula/vimex.rb               # tap recipe in RussGallaway/vimex itself
install.sh
docs/manual.md                 # shared source for UI guide and Unix manual
docs/man/vimex.1               # generated manual
.github/workflows/
  check.yml
  release.yml
tests/
  integration/                 # dispatch and real PTY resume tests
  terminal/                    # packaged TUI smoke checks
  install/                     # temporary-prefix install and upgrade tests
```

The distribution package owns upgrade policy; it imports no filesystem, process, HTTP, or OpenTUI implementation. platform-node supplies those volatile integrations. CLI commands reuse the existing conversation/workbench capabilities for resume rather than adding another session manager. Doctor probes dependencies without starting a conversation or changing configuration.

Keep one root application version. Derive --version output and release metadata from it; validate tags such as v0.1.0 against that version. Internal workspace packages need not be published separately.

The installer and application upgrade path must consume the same release manifest and artifact naming scheme. Keep the shell bootstrap small. Do not duplicate model/session behavior or maintain separate update and upgrade handlers.

Add colocated parser/policy unit tests, adapter integration tests, and install/upgrade smoke tests. Test unsupported platforms, checksum failure, interrupted downloads, package-manager ownership, and draft/config preservation. Existing dependency-boundary checks must include distribution for this topology.

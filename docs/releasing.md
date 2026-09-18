# Distribution and releases

Status: CLI, native packaging, installer/updater, monorepo formula, and release workflow are implemented. macOS ARM64 bundles have passed local CLI, syntax, and PTY checks outside the checkout. The four-platform workflow has not run remotely and no public release has been published.

## Distribution

Use versioned GitHub Releases as the source of platform archives, checksums, and provenance. Aim for macOS and Linux on ARM64 and x64, enabling each target only after native packaged-binary tests pass. Bun can compile executables, but OpenTUI native libraries, workers, WASM grammars, and highlight queries require explicit packaging verification.

Users should not need Bun or a checkout for a packaged release. Keep Codex separately installed and authenticated initially. Publish a tested Codex compatibility range rather than claiming compatibility with all versions.

Use the existing public monorepo, https://github.com/RussGallaway/vimex, as the tap. Keep its recipe at Formula/vimex.rb. The proposed commands, once the release and formula are published, are:

```sh
brew tap russgallaway/vimex https://github.com/RussGallaway/vimex.git
brew install russgallaway/vimex/vimex
brew upgrade vimex
```

After the qualified install trusts the formula, the unambiguous short name `vimex` is usable. An explicit URL is necessary on the first tap because this repository is not named homebrew-vimex. A fresh installation without a tap requires acceptance into Homebrew's official collection. Install the generated manual at `share/man/man1/vimex.1`.

A curl installer should detect supported OS/architecture, fetch a versioned archive, verify its checksum, and install without sudo into a documented user location. Support explicit versions and installation prefixes. Do not silently rewrite shell configuration. Prefer an atomic executable replacement and provide an uninstall procedure.

## CLI and updates

Implemented: `vimex PATH`, `vimex resume [ID]`, `vimex resume --last`, `vimex doctor`, and `vimex upgrade` with `update` as an alias. Preserve existing flags such as `--thread`.

Homebrew owns upgrades of Homebrew installations. The upgrade command should delegate to it, never overwrite its managed files. Direct installations use the same artifact selection and verification logic as the installer. Source installations receive source-update instructions.

Start with explicit upgrades and optional, dismissible update notices. Do not replace a running application during a conversation. A future background update check must have a short timeout, cached results, an opt-out, and no effect on offline startup. `:restart` only reconnects Codex; it does not update or reload Vimex.

## CI and release gates

The existing Checks workflow runs macOS/Linux checks on pushes and pull requests. Extend it with generated-document validation, native packaged smoke tests, and explicit offline PTY drivers. Keep credentials and real conversations out of public CI.

A version-tag workflow should validate the source version, run checks, build artifacts, smoke-test them outside the repository with no Bun installation, and validate syntax assets offline. Exercise both a clean install and an upgrade from the preceding release. Check `--help`, `--version`, the demo, terminal cleanup, and the installed manual.

Assemble a draft release with all archives, checksums, third-party notices, and build attestations before publication. Prefer immutable releases. After publication, update Formula/vimex.rb and its checksums on main in the same repository. Keep the application tag immutable; a formula-only follow-up commit must not trigger another release. Use narrowly scoped workflow permissions and respect branch protections. Pin workflow dependencies deliberately and avoid publishing from untrusted pull-request jobs.

## Release procedure

1. Update the root package.json version using SemVer; regenerate docs with `bun run docs:generate` when the manual changes. Run `bun run check`.
2. Commit on main, review, and push the intended source. Create and push the matching immutable tag, initially `v0.1.0`.
3. The Release workflow builds natively on macOS/Linux ARM64/x64, runs checks and packaged CLI/PTY/syntax probes, and uploads archives. `release:manifest` verifies all four archive hashes before publication.
4. Publication assembles a draft with archives, vimex-release.json, SHA256SUMS, install.sh, and provenance. It publishes only after upload succeeds.
5. Stable publication generates Formula/vimex.rb from the release manifest, opens a formula-only pull request, dispatches the required checks for its commit, and enables squash auto-merge. Formula-only PRs skip the ordinary contributor workflow and use a protected-base `pull_request_target` run that verifies the bot actor, same-repository release branch, and formula-only diff before testing. This supplies PR-associated protected checks without a manual approval gate. Prereleases leave the stable formula unchanged.

Rerunning a failed publication reuses a draft. Published assets are never replaced; a retry downloads the already published manifest before proposing the formula update. Formula-branch retries use the observed remote commit as their force-with-lease boundary. If the automated formula proposal or merge fails, download that manifest, run `bun run release:formula PATH`, and submit the generated change through the repository's required review process. Do not move the release tag. Formula updates are skipped when the tag is no longer GitHub's latest stable release.

The workflow needs contents:write for publication and formula branches, pull-requests:write for the formula proposal, and id-token:write plus attestations:write for provenance. It does not need another repository's token. Keep publishing tied to trusted tags. A real Homebrew install/upgrade and previous-release upgrade acceptance remain release gates; fixture tests do not establish those results before a first release exists.

Local packaging tests live in tests/install. Native archives include OpenTUI assets, the generated manual, MIT license, and dependency notices. Runtime asset resolution follows the executable's real path so launcher symlinks work. No release operation was performed as part of implementing this pipeline.

## Before making the repository public

- MIT has been adopted in the top-level LICENSE; verify notices are included in release archives.
- Review bundled dependency licenses and parser provenance; ship required notices.
- Audit tracked files and history for credentials, personal data, and local paths.
- Refresh README, install instructions, examples, screenshots, and compatibility claims.
- Add a security reporting policy and issue templates; verify contribution instructions.
- Record supported platforms and outstanding acceptance limitations honestly.

Recommended sequence: packaging proof, CLI, installer/updater, release workflow and tap, then a public preview release.

References: [Homebrew taps](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap), [Bun executables](https://bun.com/docs/bundler/executables), [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

## Version policy

The intended initial release is 0.1.0, tagged v0.1.0. Use Semantic Versioning. During 0.x, use patch releases for compatible fixes and minor releases for feature milestones or breaking changes, with breaking changes called out explicitly. This is our project convention; SemVer permits unstable APIs before 1.0.0. Candidate builds can use 0.1.0-rc.1, then 0.1.0-rc.2. Never replace published version contents or move a published release tag.

The compatibility surface includes CLI flags/subcommands, configuration, persisted local-state formats, and documented integration contracts. Document migration needs and keep Codex compatibility separate from Vimex's own version. work/projects/v1 remains a planning milestone, not a claim that the first release is 1.0.0.

See [SemVer](https://semver.org/), [Homebrew publishing](homebrew.md), and the [CLI topology](cli-architecture.md).

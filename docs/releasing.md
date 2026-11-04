# Distribution and releases

Status: CLI, native packaging, installer/updater, monorepo formula, and release workflow are implemented. Previous releases exercised four native platforms. New release candidates target macOS ARM64 and Linux ARM64/x64; macOS Intel is retired. The candidate-promotion workflow must be observed in Actions before claiming end-to-end deployment acceptance.

## Distribution

Use versioned GitHub Releases as the source of platform archives, checksums, and provenance. Support macOS ARM64 and Linux ARM64/x64, enabling each target only after native packaged-binary tests pass. Bun can compile executables, but OpenTUI native libraries, workers, WASM grammars, and highlight queries require explicit packaging verification.

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

The Checks workflow runs macOS/Linux checks on application pushes and pull requests. It skips the generated formula-only follow-up commit because the complete release matrix has already passed. Keep credentials and real conversations out of public CI.

The candidate workflow validates the source, builds artifacts, smoke-tests them outside the repository with no Bun installation, and validates syntax assets offline. The version-tag workflow only verifies and promotes that candidate. Exercise both a clean install and an upgrade from the preceding release. Check `--help`, `--version`, the demo, terminal cleanup, and the installed manual.

Assemble a draft release with all archives, checksums, third-party notices, and build attestations before publication. Prefer immutable releases. After publication, update Formula/vimex.rb and its checksums on main in the same repository. Keep the application tag immutable; a formula-only follow-up commit must not trigger another release. Use narrowly scoped workflow permissions and respect branch protections. Pin workflow dependencies deliberately and avoid publishing from untrusted pull-request jobs.

## Local release validation

Use the exact Bun version in `packageManager` (currently 1.3.6), Python 3.12, Git, `tar`, and a Unix PTY. Install dependencies and activate an isolated Python environment:

```sh
bun install --frozen-lockfile
python3 -m venv /tmp/vimex-release-venv
source /tmp/vimex-release-venv/bin/activate
python3 -m pip install -r tests/terminal/requirements-live.txt
bun run check:release
```

The command checks prerequisites before the expensive tests, then stops on the first failed stage:

1. Run `bun run check` and `git diff --check` with `HERDR_ENV=0`, `HUSKY=0`, and `TERM=xterm-256color`.
2. Build the native executable with its OpenTUI libraries, workers, vendored parsers, manual, and dependency notices.
3. Create the release archive and verify its metadata and SHA-256 against the actual bytes.
4. Extract the archive outside the checkout, then run headless CLI smoke, compiled offline syntax, real-process visual PTY, and fixture-backed resume probes against the extracted assets.

The default output is an isolated temporary directory. Success removes it; failure retains build and frame artifacts and prints their location. Checks that fail before building report directly in the terminal. For persistent output, use:

```sh
bun run check:release --outdir dist
```

This retains the native bundle, archive, per-platform JSON metadata, and `frames/` captures. The PNG, text, and JSON frames reconstruct terminal cells; they are not OS screenshots. The command uses demo and fake app-server fixtures without Codex credentials or real conversations, and performs no publication or Homebrew installation.

The Checks workflow lints workflow expressions and shell steps with pinned actionlint, and runs the complete source gate on all three supported native platforms. On main-branch pushes and manual main-branch runs, successful checks unlock native packaging with `bun run check:release --package-only --outdir dist`. Pull-request runs validate source but cannot produce promotable candidates. Packaging still runs prerequisites, whitespace checks, builds, checksums, CLI, offline syntax, visual PTY, and resume probes. A separate install probe runs the real bootstrap into temporary prefixes with the candidate archive, then installs the newest preceding stable release and upgrades it to the candidate. It checks executable versions, CLI help, receipts, the installed manual, and retention of the old version. Downloads of the previous release use GitHub; the bootstrap receives verified archives through a restricted local curl fixture. A missing previous baseline fails this probe explicitly.

After every platform passes, the candidate job verifies the complete three-platform manifest, generates and syntax-checks the Homebrew formula, and records hashes of all archives, the manifest, checksum file, installer, and formula. The receipt binds these files to the source commit, workflow run, and attempt. Build provenance is attested before candidate readiness, so attestation permissions are exercised before tagging. The final immutable artifact is retained for 14 days. Formula syntax/generation checks do not substitute for a real Homebrew install test.

Release runs only on a matching version tag (including a manual rerun against that tag). It selects a successful Checks run for the exact commit from this repository's main branch, downloads its candidate by artifact ID, and verifies identity, the exact file inventory, and every checksum. It never builds or reruns source tests. Failed, PR/fork, unrelated, expired, or missing candidates cannot publish. Re-run Checks on the same commit if the candidate expires; do not silently rebuild during promotion. Local `bun run check:release` remains the full host gate by default.
Separate jobs let GitHub's **Re-run failed jobs** preserve successful validation and packaging jobs. The final candidate name includes the run attempt; promotion selects only the current successful attempt. There are no automatic test retries or ignored failures. Failed validation logs and packaging logs/bundles/frames are retained as diagnostic artifacts for 14 days; these are excluded from publication. UI test files run in separate Bun processes so one timed-out React operation cannot contaminate later files. The paired 10k-block navigation regression has a 60-second harness timeout; its semantic assertions remain unchanged. A successful local run establishes results only for the current host. The full native matrix, publication permissions, attestations, and formula deployment still require GitHub Actions. Real Homebrew installation and previous-release upgrade acceptance remain separate checks.

## Release procedure

Before creating a tag, wait for the Checks run caused by the push to main, or use `gh workflow run check.yml --ref main` to prepare the current main commit manually. Confirm its SHA matches the intended tag. Use **Re-run all jobs** on that original Checks run to refresh an expired candidate without changing its SHA; GitHub's rerun eligibility window still applies. A manual Release invocation must select the version tag, not main.

1. Update root package.json using SemVer and commit the final source, including generated docs when needed. Run `bun run check:release` locally for host-level evidence.
2. Push the intended release commit to main and wait for **Checks**, including its candidate job, to succeed. Do not tag first. Inspect failures and repair the candidate before releasing.
3. At that exact commit, run `bun run release:ready`. This read-only command checks GitHub for an unexpired, successful main-branch candidate. Then create `v<VERSION>` pointing to that exact SHA and push the tag. If main advanced (including a formula-only commit), do not accidentally tag its new HEAD.
4. Release verifies and promotes the already-attested stored bytes into a draft, then publishes. The candidate receipt is included for traceability. Existing published releases remain immutable; a retry verifies the published manifest matches the candidate before repairing formula deployment.
5. Stable publication generates Formula/vimex.rb from the verified release manifest, asserts that it is the only staged file, commits it on the current tip of main with `chore(homebrew): update formula for v…`, and fast-forwards main with a repository-scoped write deploy key. One main ruleset lets deploy keys bypass only the PR/check gate; a second ruleset still prevents deletion and force pushes and requires linear history. The formula therefore needs neither a synthetic pull request nor a second CI run after the complete release matrix passes. Prereleases leave the stable formula unchanged.

Rerunning a failed publication reuses a draft. Published assets are never replaced; a retry downloads the already published manifest before deploying the formula update. The formula push is fast-forward only and fails safely if main advances during generation. If it fails, rerun the release workflow after inspecting the cause; it reuses the published manifest and current main. Do not move the release tag. Inspect the first failure before retrying: later React failures can be consequences of an earlier timeout. If the same failure repeats, repair it on main and release a new version instead of retrying indefinitely or weakening a gate. Formula updates are skipped when the tag is no longer GitHub's latest stable release.

The workflow needs contents:write for publication and id-token:write plus attestations:write for provenance. `VIMEX_RELEASE_DEPLOY_KEY` contains the private half of one write deploy key installed only on this repository; the workflow uses it solely for the post-release formula commit and removes it from the job environment and filesystem immediately after use. GitHub models deploy-key bypass at repository scope rather than per key, so do not add another write deploy key without reviewing this trust boundary. Keep publishing tied to trusted tags. A real Homebrew install/upgrade and previous-release upgrade acceptance remain release gates; fixture tests do not establish those results before a first release exists.

Local packaging tests live in tests/install. Native archives include OpenTUI assets, the generated manual, MIT license, and dependency notices. Runtime asset resolution follows the executable's real path so launcher symlinks work. GitHub release immutability is enabled for releases published after v0.1.1; GitHub does not retroactively seal earlier releases, so the workflow's published-release recovery guard remains necessary for v0.1.0 and v0.1.1.

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

## Failure investigation and remaining boundaries

The v0.16.0 preflight exposed five-second native/Git/Python fixture timeouts and a keyboard-frame budget failure. After those repairs, a separate tag-triggered rebuild crashed Bun on Linux ARM (`Segmentation fault at address 0x8`), despite the preflight succeeding for the same SHA. Promotion removes that second build/test lottery. It does not mask test failures or automatically retry runtime crashes. Validation and install logs, packaging output, and terminal frames remain diagnostic artifacts; capture runtime crash output from the Actions job log.

GitHub publication, release immutability, and the formula deploy key can still fail during promotion. Those external permissions cannot be proven by local tests. Publication retries reuse the same verified candidate, and formula-only deployment remains isolated from application builds. No workflow or candidate artifact should be treated as proof of a real Homebrew upgrade unless that installation was separately exercised.

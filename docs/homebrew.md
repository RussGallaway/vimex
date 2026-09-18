# Publishing Vimex through Homebrew

Status: Formula/vimex.rb is published from this repository. Stable releases generate its versioned URLs and checksums from the verified release manifest, then deploy the formula automatically after the full release matrix passes.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Formula | Ruby recipe describing versioned sources, checksums, dependencies, installation, and a test; typically used for CLI tools and libraries |
| Tap | A Git repository containing formulae or casks; anyone can maintain their own |
| homebrew/core | Homebrew's official formula collection, maintained through its review process |
| Bottle | A prebuilt installation of a formula, produced for a supported platform; users usually install a bottle rather than compile locally |
| Cask | Recipe for supported prebuilt applications/artifacts, commonly GUI applications; not the proposed source-based core route for Vimex |

An upstream release archive and a Homebrew bottle are different artifacts. Our tap may initially install our release binaries; that does not make the same recipe eligible for core. A core formula needs a supported source build for native software.

## Our tap

Keep the formula in the application monorepo: https://github.com/RussGallaway/vimex, at Formula/vimex.rb. A separate repository is not required. Homebrew explicitly supports a named tap backed by an arbitrary Git URL.

Once the formula and first release are published, install with:

```sh
brew tap russgallaway/vimex https://github.com/RussGallaway/vimex.git
brew install russgallaway/vimex/vimex
```

The first command associates the local tap name with our actual repository. Without the explicit URL, Homebrew would infer RussGallaway/homebrew-vimex, which is not our repository. A fully qualified install selects and trusts the specific formula; after that, the unambiguous short name vimex is usable.

This layout keeps application and packaging reviews together and avoids cross-repository release credentials. The tradeoff is that Homebrew clones and updates the application repository, including its tracked assets, rather than a small recipes-only repository. Ordinary application commits update the tap checkout but do not upgrade the installed executable unless the formula version or revision changes.

A dedicated homebrew-* repository is a useful convention when distributing multiple independent tools or needing shorter first-install commands. For our monorepo preference, that convenience does not justify another maintained repository. Keep the formula in Homebrew's recognized top-level Formula directory, not an arbitrary nested packaging directory.

Publish immutable application release assets first, then update Formula/vimex.rb on main to reference their versioned URLs and checksums. The formula continues pointing at the last published release while development proceeds. Do not move the release tag to include this follow-up recipe commit.

Each Vimex release updates the formula's versioned URL and SHA-256. brew update refreshes package definitions; brew upgrade vimex upgrades the installed package. A tap does not require admission to Homebrew's official collections. Follow current tap trust prompts rather than bypassing them.

Homebrew should own Homebrew-installed updates. Both vimex update and vimex upgrade route to the same operation, delegating to brew for these installations.

Before the first release, once the formula commit is on GitHub, use `brew install --HEAD russgallaway/vimex/vimex` after the explicit tap command. This builds from main and requires Bun; stable archives include the runtime and native assets.

## Admission to core

Core admission is a reviewed pull request, not an automatic promotion after publishing a tap. Before applying, provide a stable upstream release, an acceptable open-source license, verifiable immutable sources, reproducible dependencies, source builds and tests on supported platforms, and evidence that the project meets Homebrew's shared acceptance policy. Disable direct self-update behavior in Homebrew installations.

As checked on September 18, 2026, the shared policy normally requires a repository at least 30 days old and public interest: 30 forks, 30 watchers, or 75 stars; for an owner self-submission, 90 forks, 90 watchers, or 225 stars. Maintainers may consider exceptions, and meeting thresholds does not guarantee admission. Recheck the policy when submitting.

For Vimex, native OpenTUI/Bun packaging and a clean source build are the main engineering questions. A 0.x version is not itself the deciding factor; do not describe an experimental preview as stable just to qualify. Do not make core admission a prerequisite for shipping 0.1.0 through our tap.

When eligible, check existing submissions, prepare a formula against homebrew/core, run a source install, brew test, brew audit --strict --new --online, and style checks. Submit the PR, disclose AI assistance where required, and respond to maintainer feedback. Homebrew decides acceptance and maintains the official recipe afterward.

References: [explicit-URL taps and naming conventions](https://docs.brew.sh/Taps), [tap maintenance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap), [formula requirements](https://docs.brew.sh/Acceptable-Formulae), [shared acceptance policy](https://docs.brew.sh/Package-Acceptance-Policy), [contribution process](https://docs.brew.sh/Adding-Software-to-Homebrew).

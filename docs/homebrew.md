# Publishing Vimex through Homebrew

Status: packaging plan; there is no published Vimex tap or formula yet.

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

Choose the publishing owner and create a repository named homebrew-tap. For codeinbox/homebrew-tap, Formula/vimex.rb would be the package recipe. A user could install it with brew install codeinbox/tap/vimex, which adds the tap as needed. After tapping, brew install vimex can use the short name when unambiguous.

Each Vimex release updates the formula's versioned URL and SHA-256. brew update refreshes package definitions; brew upgrade vimex upgrades the installed package. A tap does not require admission to Homebrew's official collections. Follow current tap trust prompts rather than bypassing them.

Homebrew should own Homebrew-installed updates. Both vimex update and vimex upgrade will route to the same operation, delegating to brew for these installations.

## Admission to core

Core admission is a reviewed pull request, not an automatic promotion after publishing a tap. Before applying, provide a stable upstream release, an acceptable open-source license, verifiable immutable sources, reproducible dependencies, source builds and tests on supported platforms, and evidence that the project meets Homebrew's shared acceptance policy. Disable direct self-update behavior in Homebrew installations.

As checked on September 18, 2026, the shared policy normally requires a repository at least 30 days old and public interest: 30 forks, 30 watchers, or 75 stars; for an owner self-submission, 90 forks, 90 watchers, or 225 stars. Maintainers may consider exceptions, and meeting thresholds does not guarantee admission. Recheck the policy when submitting.

For Vimex, native OpenTUI/Bun packaging and a clean source build are the main engineering questions. A 0.x version is not itself the deciding factor; do not describe an experimental preview as stable just to qualify. Do not make core admission a prerequisite for shipping 0.1.0 through our tap.

When eligible, check existing submissions, prepare a formula against homebrew/core, run a source install, brew test, brew audit --strict --new --online, and style checks. Submit the PR, disclose AI assistance where required, and respond to maintainer feedback. Homebrew decides acceptance and maintains the official recipe afterward.

References: [tap maintenance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap), [formula requirements](https://docs.brew.sh/Acceptable-Formulae), [shared acceptance policy](https://docs.brew.sh/Package-Acceptance-Policy), [contribution process](https://docs.brew.sh/Adding-Software-to-Homebrew).

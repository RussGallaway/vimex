# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.1.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.2/vimex-v0.1.2-darwin-arm64.tar.gz"
      sha256 "9f5e70b112e414e8d68f734385b1dea7465a18fb939ccaa8a740d05383d1ae13"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.2/vimex-v0.1.2-darwin-x64.tar.gz"
      sha256 "c204c849f22358b3288f97fbb0449673426f2165b98eb19db8263aac6089388a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.2/vimex-v0.1.2-linux-arm64.tar.gz"
      sha256 "b59b29ff719c002151c753d9c3dd583aaed1eac74b34dee7475e1996a67aff47"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.2/vimex-v0.1.2-linux-x64.tar.gz"
      sha256 "b839efca5e0a68416adbb0d717b0c05892cf946f5e813c981016422a3b9e07ad"
    end
  end

  head do
    url "https://github.com/RussGallaway/vimex.git", branch: "main"
    depends_on "oven-sh/bun/bun" => :build
  end

  def install
    bundle = buildpath
    if build.head?
      system "bun", "install", "--frozen-lockfile"
      system "bun", "run", "scripts/release/build.ts", "--outdir", buildpath/"bundle"
      bundle = buildpath/"bundle"
    end

    # Homebrew rewrites every Mach-O dylib ID after install. OpenTUI ships
    # without enough Mach-O header padding for Homebrew's longer opt path, so
    # keep it compressed until post_install, which runs after linkage fixing.
    if OS.mac?
      native_libraries = Dir[(bundle/"assets/opentui/**/libopentui.dylib").to_s]
      odie "Expected exactly one bundled OpenTUI dylib" unless native_libraries.one?
      system "gzip", "-n", native_libraries.first
    end
    libexec.install Dir[(bundle/"*").to_s]
    bin.install_symlink libexec/"vimex"
    man1.install libexec/"share/man/man1/vimex.1"
  end

  on_macos do
    post_install_steps do
      arch = Hardware::CPU.arm? ? "arm64" : "x64"
      native_library = "{{libexec}}/assets/opentui/@opentui/core-darwin-#{arch}/libopentui.dylib.gz"
      if_path_exists native_library do
        run "/usr/bin/gzip", args: ["-d", native_library]
      end
    end
  end

  def caveats
    "Live sessions require a separately installed Codex CLI. Run codex login before launching Vimex."
  end

  test do
    assert_equal "vimex #{version}", shell_output("#{bin}/vimex --version").strip
    assert_match "resume", shell_output("#{bin}/vimex --help")
  end
end

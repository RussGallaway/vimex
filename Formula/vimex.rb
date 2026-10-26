# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.14.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.1/vimex-v0.14.1-darwin-arm64.tar.gz"
      sha256 "a1efeff84dc135d269f15eb32e912dfd24843ac3ff6564a9c88e8fc73d2b7b53"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.1/vimex-v0.14.1-darwin-x64.tar.gz"
      sha256 "85778f52e4b49763e647f9be0d8be58f87fc09941823c0f525f30d149171a6c0"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.1/vimex-v0.14.1-linux-arm64.tar.gz"
      sha256 "50a2a447ec694da6e67525292bb1abfc8046ff32eba804450cbafcbb3fa3408d"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.1/vimex-v0.14.1-linux-x64.tar.gz"
      sha256 "3aa3c0fecfa3b62eda5e5ec60e8fb3e9b19cfcab877e73916389f0aff83e4db5"
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

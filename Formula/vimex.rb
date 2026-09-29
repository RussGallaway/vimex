# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.10.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.1/vimex-v0.10.1-darwin-arm64.tar.gz"
      sha256 "8ea6389e58b278e456d27c232b5ac91d076b8eacab8d9af1476c43fd12db952a"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.1/vimex-v0.10.1-darwin-x64.tar.gz"
      sha256 "aef82abae941b7c65d210feb06f86e9d8adb30d7931f888b1355d94fca6c6f0e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.1/vimex-v0.10.1-linux-arm64.tar.gz"
      sha256 "200ff661b3ae32df552dd0158457cd2e4209abf5fc842ba02020aa5de8063377"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.1/vimex-v0.10.1-linux-x64.tar.gz"
      sha256 "a1f1fc0e566dc64248e3c274535509a3a2c23d970606584141f9922b5c92bdf0"
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

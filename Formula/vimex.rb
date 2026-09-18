# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.0/vimex-v0.1.0-darwin-arm64.tar.gz"
      sha256 "a4d375db4a42417f5c323f4d6c38271d9ec00370f1d0ddce564a44b83c66119e"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.0/vimex-v0.1.0-darwin-x64.tar.gz"
      sha256 "ed8587087b4c75a6b9e4dc09b6a1d9a6619932495ae8822f8d5702c5dcdbfe91"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.0/vimex-v0.1.0-linux-arm64.tar.gz"
      sha256 "14e3e060e762a5eb79aaa2334d57e3a35a6aa5d52f9a108fe0a2b83e2b6e4df4"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.0/vimex-v0.1.0-linux-x64.tar.gz"
      sha256 "2ec6b9c13beccc8e31676cee35889b2eb503c46d984e79cd34d9aaaee97ada8a"
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
    assert_match "vimex", shell_output("#{bin}/vimex --version")
    assert_match "resume", shell_output("#{bin}/vimex --help")
  end
end

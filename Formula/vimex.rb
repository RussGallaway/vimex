# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.5.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.5.0/vimex-v0.5.0-darwin-arm64.tar.gz"
      sha256 "bfff1484299a7aed2ed6bc19e052bf6ad50584e6fd5cc86bccc6fafe98277296"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.5.0/vimex-v0.5.0-darwin-x64.tar.gz"
      sha256 "e786be269b23f8629abe602d321b4dda9a7d552682cccc393330edaa0a810d95"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.5.0/vimex-v0.5.0-linux-arm64.tar.gz"
      sha256 "a5244b06883b7f5f8b55da76c2b6d4b514e5cdb03540d858ecf96a8c40f4f076"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.5.0/vimex-v0.5.0-linux-x64.tar.gz"
      sha256 "ebe5e38fd5b2bfa7eb2f8e93f7d7cffedb50ea72e5dd29fe92f42d15cc8eefc6"
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

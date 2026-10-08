# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.12.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.12.0/vimex-v0.12.0-darwin-arm64.tar.gz"
      sha256 "3b3707f79fe3d828edeb73ca19fcd9bf27db7ba12be0f77eeb484905a5339430"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.12.0/vimex-v0.12.0-darwin-x64.tar.gz"
      sha256 "1778ece9b436721b13ad3b96e13d17a02852b6503f860d5eed7abc791ba6b8b9"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.12.0/vimex-v0.12.0-linux-arm64.tar.gz"
      sha256 "7ebc7ee3f1ccad94933a8642d615d190f1f441188c0143105b13b040f0c78796"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.12.0/vimex-v0.12.0-linux-x64.tar.gz"
      sha256 "70a8273eacd750e5317e6159ab8d646dd05e85d8a125fd8d924bb1e369422bec"
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

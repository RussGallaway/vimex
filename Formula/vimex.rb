# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.6.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.6.0/vimex-v0.6.0-darwin-arm64.tar.gz"
      sha256 "8ea1f6dede55d88b429283503d35747261cb788bd8f87375ce7614318fbf3a6e"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.6.0/vimex-v0.6.0-darwin-x64.tar.gz"
      sha256 "0e76002ad7df3136db6129f30d880f2d7fec001edb72ec20018f130af0e1ef52"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.6.0/vimex-v0.6.0-linux-arm64.tar.gz"
      sha256 "7033a061932e668d346f226571f8c4a4bcb7c60b77db9302eef12550d51398f9"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.6.0/vimex-v0.6.0-linux-x64.tar.gz"
      sha256 "d22d02cdfbd44f858a64940722c9db48a1b2be39b83795f13dfcce9067f8ec42"
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

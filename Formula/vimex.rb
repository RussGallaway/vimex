# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.8.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.8.1/vimex-v0.8.1-darwin-arm64.tar.gz"
      sha256 "a26390f22d8188bf6955f3d1c4b3f1d1a5b129e76a3260228da6709509562f32"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.8.1/vimex-v0.8.1-darwin-x64.tar.gz"
      sha256 "8a54d8b489b442b7632cf31db6337acba5d3c9d05ae189d4285b61550347afbe"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.8.1/vimex-v0.8.1-linux-arm64.tar.gz"
      sha256 "1ea6d0890426c408030a0cd19ed1d7ad047833a39e822f66c821adde7eb79a5d"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.8.1/vimex-v0.8.1-linux-x64.tar.gz"
      sha256 "3ca4368ec827751da14557596036689ea7e08b66c7d6b727722e180658ecf7de"
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

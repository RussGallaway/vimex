# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.3.0/vimex-v0.3.0-darwin-arm64.tar.gz"
      sha256 "d29892a94b8a4037a24a79cf6dda3f9f54c5de3dea942e24ecaa947c9bbaa40f"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.3.0/vimex-v0.3.0-darwin-x64.tar.gz"
      sha256 "d39e84786decf95f266aff91175d044099ec32bae43ec22db04442be93428682"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.3.0/vimex-v0.3.0-linux-arm64.tar.gz"
      sha256 "27bc34916861a0e9e9822907981aeeacb1656b8b6a3d778c26d0282070fc84ad"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.3.0/vimex-v0.3.0-linux-x64.tar.gz"
      sha256 "1e71003e0b8646b61e9224d73a1c60b49458b1cdcd3c3f443225eb576d50f811"
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

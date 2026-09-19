# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.4.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.4.0/vimex-v0.4.0-darwin-arm64.tar.gz"
      sha256 "20e809e24ebf72aecf3f5cfbdd9d63bc3ef36f46c616391d74af2eb6afad590b"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.4.0/vimex-v0.4.0-darwin-x64.tar.gz"
      sha256 "2a8163bbe7ab59210577002de767a98f2579d8825c1791f590dc21f360bf7728"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.4.0/vimex-v0.4.0-linux-arm64.tar.gz"
      sha256 "7ca745cc5b6323887c18eb9c608413d41555f196adad92ec802353fe9b2e7632"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.4.0/vimex-v0.4.0-linux-x64.tar.gz"
      sha256 "b0fe0de6c509d569cd2cbb76391c4a32fead618d349777442b397b8d17467fe5"
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

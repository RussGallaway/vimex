# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.14.4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.4/vimex-v0.14.4-darwin-arm64.tar.gz"
      sha256 "2724e3d144858091a669ed4eb0cd5ad008acd4bc9a33b472d75aac7ff7eeb4c1"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.4/vimex-v0.14.4-darwin-x64.tar.gz"
      sha256 "97324ed44dbde8199a427099a1cee7ab467a2e3fe03c4ffd4d7e6641d1f2aaf9"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.4/vimex-v0.14.4-linux-arm64.tar.gz"
      sha256 "14d0b71ef1bca7b9f9cde2e18c37cc3177c154965ddb03b8ee14742382f20ded"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.4/vimex-v0.14.4-linux-x64.tar.gz"
      sha256 "274095fd72fdca4baf5817e7c81acd19dcc8067617ea23feb23fa9a4554af519"
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

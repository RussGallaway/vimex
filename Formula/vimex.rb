# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.11.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.11.0/vimex-v0.11.0-darwin-arm64.tar.gz"
      sha256 "9c2b0dcc0ed7838844495ecd2d167dacf2967515cea5b404143bede84e9859ce"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.11.0/vimex-v0.11.0-darwin-x64.tar.gz"
      sha256 "374fcfe009943e73462a623e3c54a951877580beb29bbe2bd865cf4eacb4ab92"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.11.0/vimex-v0.11.0-linux-arm64.tar.gz"
      sha256 "0d476ddcde5b73fe6d6b3b909a0130845254e3d0d87b4498dca9ba32fbeb3127"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.11.0/vimex-v0.11.0-linux-x64.tar.gz"
      sha256 "18c55287ebff7da89c7c2da15d22d0bbd748e779a5d59ae294ee4cdb404cef17"
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

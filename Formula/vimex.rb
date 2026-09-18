# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.1.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.1/vimex-v0.1.1-darwin-arm64.tar.gz"
      sha256 "f2f4554b54014faea64d29d1d15a5e163e86f76f8820faa32bc310eab76f220f"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.1/vimex-v0.1.1-darwin-x64.tar.gz"
      sha256 "f73d3d7e1122db68a2174c00a0bd85ec2e323698f53656b8db04624c4d17e3e8"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.1/vimex-v0.1.1-linux-arm64.tar.gz"
      sha256 "57e1916bcb3f85ba7b7e906b2cc5c2d8ceee67577b9700784ae20ec4df9be3e2"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.1.1/vimex-v0.1.1-linux-x64.tar.gz"
      sha256 "daba94d303e6a5ca46115fb10c840d0828140684abb336d08e1b703003b1d784"
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

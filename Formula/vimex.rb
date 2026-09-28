# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.9.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.9.0/vimex-v0.9.0-darwin-arm64.tar.gz"
      sha256 "6ff76936a001ef91592a6d10ecdbd232f7aac8ae02cc86694a5e1846836f52fa"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.9.0/vimex-v0.9.0-darwin-x64.tar.gz"
      sha256 "d0db57e5bd4b2c13263bd8e8068fff985cd20e6be6c29442f108daf207303a19"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.9.0/vimex-v0.9.0-linux-arm64.tar.gz"
      sha256 "762340595f316fc6259a3ef404c32ede76099685b61cc37594c2b41778318368"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.9.0/vimex-v0.9.0-linux-x64.tar.gz"
      sha256 "24ec5a595a59c674e7b3ce431cedef388081a752329fcdc468138f8750a5ff48"
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

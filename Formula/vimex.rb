# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.15.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.15.0/vimex-v0.15.0-darwin-arm64.tar.gz"
      sha256 "857745a345174d6bc4e7c708fcb28fc53ca718014bb957a6b674fe3e60899900"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.15.0/vimex-v0.15.0-darwin-x64.tar.gz"
      sha256 "ebd1857be3456b8b736f57ee50869566e83263cac63276f7436b3e6c366fe26b"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.15.0/vimex-v0.15.0-linux-arm64.tar.gz"
      sha256 "3f829267a6d289438ad151e63a770420dc59193806b286b587cbfe6bd2596983"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.15.0/vimex-v0.15.0-linux-x64.tar.gz"
      sha256 "1a6b8a032d632f52bd4543c936c890f6be284f19859fe38c7829795de723a48a"
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

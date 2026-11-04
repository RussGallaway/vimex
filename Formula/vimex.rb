# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.16.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.16.0/vimex-v0.16.0-darwin-arm64.tar.gz"
      sha256 "112b3d0c4bc6edde8f13b64dffa7b9c724885362d5e19b3284fd1846f93be63c"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.16.0/vimex-v0.16.0-darwin-x64.tar.gz"
      sha256 "484bb4f879119d216f62778d5bb80d5a0185794ea28a248d70d5791fb7e744c4"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.16.0/vimex-v0.16.0-linux-arm64.tar.gz"
      sha256 "58ca60cd541fd1097f1f50c6fc0190225c8c383a994cf20b6c98d1eb18fb2e51"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.16.0/vimex-v0.16.0-linux-x64.tar.gz"
      sha256 "7392716a590bfb16c97e6f1842e45db73f76c900e529f52689903bb5542112c2"
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

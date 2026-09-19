# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.2.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.2.1/vimex-v0.2.1-darwin-arm64.tar.gz"
      sha256 "2238d925e36a73b77ac786d806123cbb33b366655631ae3098bf0c09dc0ccfb3"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.2.1/vimex-v0.2.1-darwin-x64.tar.gz"
      sha256 "52ac3bbfaaabd78cdb3efc9e009023cf2065f1af8d67386abe363b14869d5161"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.2.1/vimex-v0.2.1-linux-arm64.tar.gz"
      sha256 "a3555ec313ee3ef53c03b5a3d8ab75be28070c0484274c5de9788244e21bbd92"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.2.1/vimex-v0.2.1-linux-x64.tar.gz"
      sha256 "ed3c209e9150bd9606659affe83cd6ec392e9d64c9096ebbe5ad310a145ad3bf"
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

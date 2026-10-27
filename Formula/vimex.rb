# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.14.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.3/vimex-v0.14.3-darwin-arm64.tar.gz"
      sha256 "2249f519377051a96720fd9c890969c3cf6a043e4154b666a2c5c898115a557c"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.3/vimex-v0.14.3-darwin-x64.tar.gz"
      sha256 "dbdeb4a6c7f07763aebe646c4db94fb241b3dcb038aefa26b2845030ee6e8bac"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.3/vimex-v0.14.3-linux-arm64.tar.gz"
      sha256 "99556fadf638fd65633d7ebd15cd57a32e6f4a6b53a6a50d40d42a804804063e"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.3/vimex-v0.14.3-linux-x64.tar.gz"
      sha256 "fc42c7f58397ec1951c2cc843bfd21c6ce78b32cba99c8185e149b3c97409cff"
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

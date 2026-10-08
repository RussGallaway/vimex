# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.13.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.13.0/vimex-v0.13.0-darwin-arm64.tar.gz"
      sha256 "f8e7f81549c611f0f58b3d62048fe4fabbe223901db218cec5a40058535ede02"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.13.0/vimex-v0.13.0-darwin-x64.tar.gz"
      sha256 "4cbbf96415045fdaf607e7a1aae535ac71a2abdc3822d07121c7b4e878ee792a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.13.0/vimex-v0.13.0-linux-arm64.tar.gz"
      sha256 "67139acb373406d3a71e960e69dbcda7f5087e5556e8515b4ace391202dbb8cb"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.13.0/vimex-v0.13.0-linux-x64.tar.gz"
      sha256 "d113eefb80a9406bfdade51910ec9a679ebadf7f13faafe27aa104fc9adc6227"
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

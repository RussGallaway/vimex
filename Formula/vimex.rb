# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.10.4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.4/vimex-v0.10.4-darwin-arm64.tar.gz"
      sha256 "04b8c6a617e86250faa6eb48ebead9f69ebc2ed3a49033a860ae3cc3a7ce41ad"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.4/vimex-v0.10.4-darwin-x64.tar.gz"
      sha256 "c8cd86f0075e4b4e6ff2ecc9f122d468e27efdad98fcd970851558de8d896d28"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.4/vimex-v0.10.4-linux-arm64.tar.gz"
      sha256 "98d39dd7fcc12d8e31e3aa799826fa33f0d4e8e92c74865514316cc45af3cdc4"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.10.4/vimex-v0.10.4-linux-x64.tar.gz"
      sha256 "6ec9b6e9455780f48c0f77ee64e509fe9ea0be3ef9bc76cb2d24aa3e73d4f2a3"
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

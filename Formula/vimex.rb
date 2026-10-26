# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "0.14.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.0/vimex-v0.14.0-darwin-arm64.tar.gz"
      sha256 "52f18749a2d6477fa1fd420ceaee77004ff077514a6c2613a6c47ee8774349ef"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.0/vimex-v0.14.0-darwin-x64.tar.gz"
      sha256 "9934afe316ad797f1f22d71245ad90672db1ff82a144a10cfd8da0b2a548e9ae"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.0/vimex-v0.14.0-linux-arm64.tar.gz"
      sha256 "72ab45c1176a2b33cc93c3fdea0bd81af2b902e2d66d9af34fe05df8dad2baba"
    end
    on_intel do
      url "https://github.com/RussGallaway/vimex/releases/download/v0.14.0/vimex-v0.14.0-linux-x64.tar.gz"
      sha256 "2635f0e2a541d6b39c94d52eec35715d0505946ca75744dcdca4367854aeeaf5"
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

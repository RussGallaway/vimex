class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  license "MIT"
  # No stable artifacts exist yet. The release workflow generates the stable stanza.
  head "https://github.com/RussGallaway/vimex.git", branch: "main"

  depends_on "oven-sh/bun/bun" => :build

  def install
    system "bun", "install", "--frozen-lockfile"
    system "bun", "run", "docs:check"
    system "bun", "run", "scripts/release/build.ts", "--outdir", buildpath/"bundle"
    libexec.install Dir["bundle/*"]
    bin.install_symlink libexec/"vimex"
    man1.install libexec/"share/man/man1/vimex.1"
  end

  def caveats
    "Live sessions require a separately installed Codex CLI. Run codex login before launching Vimex."
  end

  test do
    assert_match "vimex", shell_output("#{bin}/vimex --version")
    assert_match "resume", shell_output("#{bin}/vimex --help")
  end
end

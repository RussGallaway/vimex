import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseRelease } from "@vimex/distribution"

const file = process.argv[2]
if (!file) throw new Error("Usage: update-homebrew.ts MANIFEST [OUTPUT]")
const release = parseRelease(JSON.parse(await readFile(file, "utf8")))
if (release.artifacts.length !== 4) throw new Error("Homebrew publication requires four platform artifacts")
const stanza = (platform: "darwin" | "linux") => `  on_${platform === "darwin" ? "macos" : "linux"} do\n` + ["arm64", "x64"].map(arch => {
  const asset = release.artifacts.find(value => value.platform === platform && value.arch === arch)
  if (!asset || asset.name !== `vimex-v${release.version}-${platform}-${arch}.tar.gz`) throw new Error(`Missing/mismatched ${platform}/${arch} archive`)
  return `    on_${arch === "arm64" ? "arm" : "intel"} do\n      url "https://github.com/RussGallaway/vimex/releases/download/v${release.version}/${asset.name}"\n      sha256 "${asset.sha256}"\n    end\n`
}).join("") + "  end\n"
const formula = `# Generated from a published release manifest; do not invent checksums.
class Vimex < Formula
  desc "Full-screen Vim-operated interface for the Codex app server"
  homepage "https://github.com/RussGallaway/vimex"
  version "${release.version}"
  license "MIT"

${stanza("darwin")}
${stanza("linux")}
  head do
    url "https://github.com/RussGallaway/vimex.git", branch: "main"
    depends_on "oven-sh/bun/bun" => :build
  end

  def install
    if build.head?
      system "bun", "install", "--frozen-lockfile"
      system "bun", "run", "scripts/release/build.ts", "--outdir", buildpath/"bundle"
      libexec.install Dir["bundle/*"]
    else
      libexec.install "vimex", "assets", "share", "LICENSE"
    end
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
`
await writeFile(resolve(process.argv[3] ?? "Formula/vimex.rb"), formula)

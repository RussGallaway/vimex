import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseRelease } from "@vimex/distribution"
const repo = resolve(import.meta.dir, "../..")
const { version } = JSON.parse(
  await readFile(join(repo, "package.json"), "utf8"),
)
async function execute(script: string, ...args: string[]) {
  const process = Bun.spawn(
    [Bun.which("bun")!, join(repo, "scripts/release", script), ...args],
    { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { code, stdout, stderr }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vimex-release-metadata-"))
  const artifacts = []
  for (const platform of ["darwin", "linux"] as const)
    for (const arch of ["arm64", "x64"] as const) {
      const name = `vimex-v${version}-${platform}-${arch}.tar.gz`
      const bytes = Buffer.from(`fixture ${platform}/${arch}`)
      const artifact = {
        platform,
        arch,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }
      await writeFile(join(directory, name), bytes)
      await writeFile(
        join(directory, name.replace(/\.tar\.gz$/, ".json")),
        JSON.stringify({ version, artifacts: [artifact] }),
      )
      artifacts.push(artifact)
    }
  return {
    directory,
    artifacts,
    close: () => rm(directory, { recursive: true, force: true }),
  }
}
test("release generator verifies four archives and emits matching manifest, sums and Homebrew formula", async () => {
  const f = await fixture()
  try {
    const result = await execute("manifest.ts", f.directory)
    expect(result.code).toBe(0)
    const manifest = join(f.directory, "vimex-release.json")
    const release = parseRelease(JSON.parse(await readFile(manifest, "utf8")))
    expect(release.artifacts).toEqual(f.artifacts)
    const checksums = await readFile(join(f.directory, "SHA256SUMS"), "utf8")
    for (const artifact of f.artifacts)
      expect(checksums).toContain(`${artifact.sha256}  ${artifact.name}\n`)
    const formula = join(f.directory, "vimex.rb")
    expect((await execute("update-homebrew.ts", manifest, formula)).code).toBe(
      0,
    )
    const source = await readFile(formula, "utf8")
    for (const artifact of f.artifacts) {
      expect(source).toContain(
        `https://github.com/RussGallaway/vimex/releases/download/v${version}/${artifact.name}`,
      )
      expect(source).toContain(`sha256 "${artifact.sha256}"`)
    }
    expect(source).toContain('system "gzip", "-n", native_libraries.first')
    expect(source).toContain("post_install_steps do")
    expect(source).toContain("if_path_exists native_library do")
    expect(source).toContain(
      'run "/usr/bin/gzip", args: ["-d", native_library]',
    )
    expect(source).toContain('libexec.install Dir[(bundle/"*").to_s]')
    expect(source).toContain('bin.install_symlink libexec/"vimex"')
    expect(source).toContain(
      'assert_equal "vimex #{version}", shell_output("#{bin}/vimex --version").strip',
    )
    if (Bun.which("ruby")) {
      const ruby = Bun.spawn(["ruby", "-c", formula], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await ruby.exited).toBe(0)
    }
  } finally {
    await f.close()
  }
})
test("release generator rejects tampered bytes and missing platforms before emitting manifest", async () => {
  for (const failure of ["checksum", "missing"] as const) {
    const f = await fixture()
    try {
      const artifact = f.artifacts[0]!
      if (failure === "checksum")
        await writeFile(join(f.directory, artifact.name), "tampered")
      else
        await rm(
          join(f.directory, artifact.name.replace(/\.tar\.gz$/, ".json")),
        )
      const result = await execute("manifest.ts", f.directory)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(
        failure === "checksum" ? "Checksum mismatch" : "all four",
      )
      expect(
        await Bun.file(join(f.directory, "vimex-release.json")).exists(),
      ).toBe(false)
    } finally {
      await f.close()
    }
  }
})
test("formula generator refuses malformed checksums, missing platforms, and mismatched filenames", async () => {
  const f = await fixture()
  try {
    for (const artifacts of [
      f.artifacts.slice(1),
      [{ ...f.artifacts[0], sha256: "invented" }, ...f.artifacts.slice(1)],
      [
        { ...f.artifacts[0], name: "another-release.tar.gz" },
        ...f.artifacts.slice(1),
      ],
    ]) {
      const manifest = join(f.directory, "invalid.json"),
        output = join(f.directory, "invalid.rb")
      await writeFile(manifest, JSON.stringify({ version, artifacts }))
      expect(
        (await execute("update-homebrew.ts", manifest, output)).code,
      ).not.toBe(0)
      expect(await Bun.file(output).exists()).toBe(false)
    }
  } finally {
    await f.close()
  }
})

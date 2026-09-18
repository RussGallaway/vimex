import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installDirect } from "./direct-installer"
import { detectInstallation } from "./installation-receipt"
import { homebrewUpgrade, runProcess } from "./homebrew"
import { GithubReleases } from "./github-releases"
import { diagnoseNode } from "./diagnostics"

async function fixture(link = false, complete = true) {
  const directory = await mkdtemp(join(tmpdir(), "vimex-distribution-")), root = join(directory, "install"), source = join(directory, "bundle")
  await mkdir(join(root, "versions", "old"), { recursive: true }); await mkdir(join(source, "assets"), { recursive: true })
  await writeFile(join(root, "versions", "old", "vimex"), "old binary")
  await symlink("versions/old", join(root, "current"))
  await writeFile(join(root, ".vimex-install.json"), JSON.stringify({ schemaVersion: 1, kind: "direct", version: "0.1.0" }))
  await writeFile(join(root, "config.json"), "user configuration")
  await writeFile(join(source, "vimex"), "new binary")
  await writeFile(join(source, "assets", "parser.wasm"), "parser asset")
  if (complete) {
    await mkdir(join(source, "share", "man", "man1"), { recursive: true })
    await writeFile(join(source, "share", "man", "man1", "vimex.1"), ".TH VIMEX 1\n")
  }
  if (link) await symlink("/tmp", join(source, "assets", "unsafe"))
  const archive = join(directory, "release.tar.gz")
  expect((await runProcess("tar", ["-czf", archive, "-C", source, "."])).code).toBe(0)
  const bytes = new Uint8Array(await readFile(archive))
  const artifact = { platform: "darwin" as const, arch: "arm64" as const, name: "vimex-v0.2.0-darwin-arm64.tar.gz", sha256: createHash("sha256").update(bytes).digest("hex") }
  const release = { version: "0.2.0", artifacts: [artifact] }
  return { root, directory, bytes, artifact, release, close: () => rm(directory, { recursive: true, force: true }) }
}

test("direct upgrade atomically switches a verified executable and assets, preserving configuration and old version", async () => {
  const f = await fixture()
  try {
    expect(await detectInstallation(join(f.root, "current", "vimex"))).toMatchObject({ kind: "direct", root: await realpath(f.root) })
    await installDirect(f.release, f.artifact, f.root, { download: async () => f.bytes })
    expect(await readlink(join(f.root, "current"))).toStartWith("versions/0.2.0-darwin-arm64-")
    expect(await readFile(join(f.root, "current", "vimex"), "utf8")).toBe("new binary")
    expect(await readFile(join(f.root, "current", "assets", "parser.wasm"), "utf8")).toBe("parser asset")
    expect(await readFile(join(f.root, "versions", "old", "vimex"), "utf8")).toBe("old binary")
    expect(await readFile(join(f.root, "config.json"), "utf8")).toBe("user configuration")
  } finally { await f.close() }
})
test("checksum failures, interrupted downloads, and unsafe archive links preserve current", async () => {
  const f = await fixture(), unsafe = await fixture(true), incomplete = await fixture(false, false)
  try {
    await expect(installDirect(f.release, { ...f.artifact, sha256: "0".repeat(64) }, f.root, { download: async () => f.bytes })).rejects.toThrow("checksum")
    await expect(installDirect(f.release, f.artifact, f.root, { download: async () => { throw new Error("download interrupted") } })).rejects.toThrow("interrupted")
    await expect(installDirect(unsafe.release, unsafe.artifact, unsafe.root, { download: async () => unsafe.bytes })).rejects.toThrow("links or special")
    await expect(installDirect(incomplete.release, incomplete.artifact, incomplete.root, { download: async () => incomplete.bytes })).rejects.toThrow("Incomplete release archive")
    expect(await readlink(join(f.root, "current"))).toBe("versions/old")
    expect(await readlink(join(unsafe.root, "current"))).toBe("versions/old")
    expect(await readlink(join(incomplete.root, "current"))).toBe("versions/old")
  } finally { await f.close(); await unsafe.close(); await incomplete.close() }
})
test("ownership checks refuse current bundles outside the installation", async () => {
  const f = await fixture()
  try {
    await rm(join(f.root, "current")); await symlink(f.directory, join(f.root, "current"))
    await expect(installDirect(f.release, f.artifact, f.root, { download: async () => { throw new Error("must not download") } })).rejects.toThrow("outside")
  } finally { await f.close() }
})
test("Homebrew delegates exact command; doctor only probes versions and reads configuration", async () => {
  const calls: string[][] = []
  const run = async (name: string, args: readonly string[]) => { calls.push([name, ...args]); return { code: 0, stdout: `${name} version 1`, stderr: "" } }
  await homebrewUpgrade(run)
  expect(calls).toEqual([["brew", "upgrade", "russgallaway/vimex/vimex"]])
  const f = await fixture()
  try {
    const config = join(f.directory, "config.json")
    await writeFile(config, JSON.stringify({ codexExecutable: "/fake/codex" }))
    const checks = await diagnoseNode({ version: "0.1.0", config, cwd: f.directory, installation: async () => ({ kind: "source" }), run })
    expect(checks.find(check => check.name === "Codex")?.status).toBe("ok")
    expect(calls.slice(1)).toEqual([["/fake/codex", "--version"], ["git", "--version"]])
    expect(await readFile(config, "utf8")).toBe(JSON.stringify({ codexExecutable: "/fake/codex" }))
  } finally { await f.close() }
})
test("GitHub manifest must match its release tag and request failures are explicit", async () => {
  const seen: string[] = []
  const releases = new GithubReleases({ fetch: (async (input: string | URL | Request) => {
    seen.push(String(input)); return new Response(JSON.stringify({ version: "9.0.0", artifacts: [] }), { status: 200 })
  }) as typeof fetch })
  await expect(releases.get("0.2.0")).rejects.toThrow("does not match")
  expect(seen).toEqual(["https://github.com/RussGallaway/vimex/releases/download/v0.2.0/vimex-release.json"])
  const broken = new GithubReleases({ fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch })
  await expect(broken.get()).rejects.toThrow("503")
})

test("receipt refresh failure reports installed warning after the atomic switch", async () => {
  const f = await fixture()
  try {
    const result = await installDirect(f.release, f.artifact, f.root, { download: async () => f.bytes, run: async (command, args, options) => {
      const result = await runProcess(command, args, options)
      if (args[0] === "-xzf") { await rm(join(f.root, ".vimex-install.json")); await mkdir(join(f.root, ".vimex-install.json")) }
      return result
    } })
    expect(result.warning).toContain("new version is active")
    expect(await readFile(join(f.root, "current", "vimex"), "utf8")).toBe("new binary")
  } finally { await f.close() }
})
test("diagnostic subprocess timeout is bounded even when SIGTERM is ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-timeout-")), pidPath = join(directory, "pid")
  try {
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 100)`
    await expect(runProcess(process.execPath, ["-e", script], { timeoutMs: 100 })).rejects.toThrow("timed out")
    const pid = Number(await readFile(pidPath, "utf8"))
    await Bun.sleep(350)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("Homebrew libexec symlink ownership routes upgrades to the package manager", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-brew-owner-"))
  try {
    const cellar = join(directory, "Cellar/vimex/0.1.0/libexec"), bin = join(directory, "bin")
    await mkdir(cellar, { recursive: true }); await mkdir(bin)
    await writeFile(join(cellar, "vimex"), "compiled executable")
    await symlink(join(cellar, "vimex"), join(bin, "vimex"))
    expect(await detectInstallation(join(bin, "vimex"))).toEqual({ kind: "homebrew" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
const repo = resolve(import.meta.dir, "../..")
let temporary: string
let fakeBin: string
let archive: string
let checksums: string
const platform = process.platform === "darwin" ? "darwin" : "linux"
const artifact = `vimex-v0.1.0-${platform}-${process.arch}.tar.gz`
async function run(cmd: string[], cwd?: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw new Error(`${cmd.join(" ")}: ${err}`)
  return out
}
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "vimex-bootstrap-test-"))
  fakeBin = join(temporary, "bin")
  const payload = join(temporary, "payload")
  await mkdir(fakeBin)
  await mkdir(join(payload, "assets"), { recursive: true })
  await mkdir(join(payload, "share/man/man1"), { recursive: true })
  await writeFile(join(payload, "vimex"), '#!/bin/sh\nprintf "vimex 0.1.0\\n"\n')
  await writeFile(join(payload, "assets/parser"), "native fixture")
  await writeFile(join(payload, "share/man/man1/vimex.1"), ".TH VIMEX 1\n")
  await writeFile(join(payload, "LICENSE"), "MIT")
  archive = join(temporary, "release.tar.gz")
  await run(["tar", "-czf", archive, "vimex", "assets", "share", "LICENSE"], payload)
  checksums = join(temporary, "SHA256SUMS")
  await writeFile(checksums, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  ${artifact}\n`)
  await writeFile(join(fakeBin, "curl"), `#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; out=$1;; https://*) url=$1;; esac
  shift
done
case "$url" in
  https://api.github.com/repos/RussGallaway/vimex/releases/latest) printf '{"tag_name":"v0.1.0"}\\n';;
  https://github.com/RussGallaway/vimex/releases/download/v0.1.0/SHA256SUMS) cp "$TEST_CHECKSUMS" "$out";;
  https://github.com/RussGallaway/vimex/releases/download/v0.1.0/vimex-*.tar.gz) cp "$TEST_ARCHIVE" "$out";;
  *) printf 'Unexpected URL %s\\n' "$url" >&2; exit 70;;
esac
`)
  await chmod(join(fakeBin, "curl"), 0o755)
})
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })
async function install(name: string, overrides: Record<string, string> = {}) {
  const root = join(temporary, name, "root"), bin = join(temporary, name, "bin")
  const child = Bun.spawn(["sh", join(repo, "install.sh")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, VIMEX_INSTALL_ROOT: root, VIMEX_BIN_DIR: bin, VIMEX_VERSION: "0.1.0", TEST_ARCHIVE: archive, TEST_CHECKSUMS: checksums, ...overrides } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { root, bin, code, out, err }
}
test("bootstrap installs verified native bundle into isolated prefix and safely upgrades current", async () => {
  const first = await install("happy")
  expect(first.code).toBe(0)
  const previous = await readlink(join(first.root, "current"))
  expect(await readlink(join(first.bin, "vimex"))).toBe(join(first.root, "current/vimex"))
  expect(JSON.parse(await readFile(join(first.root, ".vimex-install.json"), "utf8"))).toEqual({ schemaVersion: 1, kind: "direct", version: "0.1.0" })
  expect((await run([join(first.bin, "vimex"), "--version"])).trim()).toBe("vimex 0.1.0")
  const next = await install("happy", { VIMEX_VERSION: "" })
  expect(next.code).toBe(0)
  expect(await readlink(join(first.root, "current"))).not.toBe(previous)
  expect(await readFile(join(first.root, previous, "assets/parser"), "utf8")).toBe("native fixture")
})
test("checksum failure preserves current version", async () => {
  const first = await install("checksum")
  const current = await readlink(join(first.root, "current"))
  const bad = join(temporary, "bad-checksums")
  await writeFile(bad, `${"0".repeat(64)}  ${artifact}\n`)
  const result = await install("checksum", { TEST_CHECKSUMS: bad })
  expect(result.code).not.toBe(0)
  expect(result.err).toContain("Checksum mismatch")
  expect(await readlink(join(first.root, "current"))).toBe(current)
})
test("installer refuses unrelated binaries and archives containing links", async () => {
  const bin = join(temporary, "unrelated/bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "vimex"), "owned by something else")
  expect((await install("unrelated")).err).toContain("unrelated executable")
  expect(await readFile(join(bin, "vimex"), "utf8")).toBe("owned by something else")
  const evil = join(temporary, "evil")
  await mkdir(evil)
  await symlink("/tmp", join(evil, "assets"))
  const evilArchive = join(temporary, "evil.tar.gz")
  await run(["tar", "-czf", evilArchive, "assets"], evil)
  const evilChecksums = join(temporary, "evil-checksums")
  await writeFile(evilChecksums, `${createHash("sha256").update(await readFile(evilArchive)).digest("hex")}  ${artifact}\n`)
  const result = await install("unsafe", { TEST_ARCHIVE: evilArchive, TEST_CHECKSUMS: evilChecksums })
  expect(result.code).not.toBe(0)
  expect(result.err).toContain("links and special files")
})

test("installer rejects traversal entries before creating an install prefix", async () => {
  const header = Buffer.alloc(512)
  header.write("../escape", 0)
  header.write("0000644\0", 100)
  header.write("0000000\0", 108)
  header.write("0000000\0", 116)
  header.write("00000000001\0", 124)
  header.write("00000000000\0", 136)
  header.fill(32, 148, 156)
  header.write("0", 156)
  header.write("ustar\0", 257)
  header.write("00", 263)
  const checksum = [...header].reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148)
  const contents = Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511 + 1024)])
  const unsafeArchive = join(temporary, "traversal.tar.gz")
  await writeFile(unsafeArchive, Bun.gzipSync(contents))
  const unsafeChecksums = join(temporary, "traversal-checksums")
  await writeFile(unsafeChecksums, `${createHash("sha256").update(await readFile(unsafeArchive)).digest("hex")}  ${artifact}\n`)
  const result = await install("traversal", { TEST_ARCHIVE: unsafeArchive, TEST_CHECKSUMS: unsafeChecksums })
  expect(result.code).not.toBe(0)
  expect(result.err).toContain("Unsafe archive path")
  expect(await Bun.file(join(result.root, "escape")).exists()).toBe(false)
})

test("installer enforces managed version containment, receipt schema, and shared upgrade lock", async () => {
  const external = join(temporary, "outside-managed-root")
  await mkdir(external)
  const linked = join(temporary, "linked-versions/root")
  await mkdir(linked, { recursive: true })
  await symlink(external, join(linked, "versions"))
  expect((await install("linked-versions")).err).toContain("versions directory must not be a symlink")
  const traversal = join(temporary, "current-traversal/root")
  await mkdir(traversal, { recursive: true })
  await symlink("versions/../../outside-managed-root", join(traversal, "current"))
  expect((await install("current-traversal")).err).toContain("Current symlink does not point to a managed version")
  const owned = await install("ownership")
  expect(owned.code).toBe(0)
  const current = await readlink(join(owned.root, "current"))
  await writeFile(join(owned.root, ".vimex-install.json"), '{"schemaVersion":2,"kind":"direct","version":"0.1.0"}')
  expect((await install("ownership")).err).toContain("Invalid direct-install receipt")
  await writeFile(join(owned.root, ".vimex-install.json"), '{"schemaVersion":1,"kind":"direct","version":"0.1.0"}')
  await mkdir(join(owned.root, ".upgrade-lock"))
  expect((await install("ownership")).err).toContain("Another upgrade is running")
  expect(await readlink(join(owned.root, "current"))).toBe(current)
})

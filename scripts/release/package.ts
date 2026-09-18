import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const name = `vimex-v${version}-${process.platform}-${process.arch}`
const archive = `${name}.tar.gz`
const bundle = join(root, "dist", name)
const tar = Bun.spawn(["tar", "-czf", join(root, "dist", archive), "-C", bundle, "vimex", "assets", "share", "LICENSE"], { stdout: "inherit", stderr: "inherit" })
if (await tar.exited) throw new Error("Packaging failed")
const sha256 = createHash("sha256").update(await readFile(join(root, "dist", archive))).digest("hex")
await writeFile(join(root, "dist", `${name}.json`), JSON.stringify({ version, artifacts: [{ platform: process.platform, arch: process.arch, name: archive, sha256 }] }, null, 2) + "\n")
console.log(archive)

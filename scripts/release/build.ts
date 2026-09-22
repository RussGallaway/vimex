import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { getNodeAssets } from "@opentui/core/node-assets"

const root = resolve(import.meta.dir, "../..")
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
)
if (
  !["darwin", "linux"].includes(process.platform) ||
  !["arm64", "x64"].includes(process.arch)
)
  throw new Error("Unsupported release target")
if (process.platform === "linux" && process.env.OPENTUI_LIBC === "musl")
  throw new Error("Release bundles currently target glibc Linux")
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--outdir"))
  throw new Error("Usage: build.ts [--outdir PATH]")
const bundle = `vimex-v${version}-${process.platform}-${process.arch}`
const destination = resolve(args[1] ?? join(root, "dist", bundle))
await mkdir(destination, { recursive: true })
const build = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "--target=bun",
    "--define",
    "VIMEX_COMPILED=true",
    join(root, "apps/cli/src/main.ts"),
    "--outfile",
    join(destination, "vimex"),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
)
if (await build.exited) throw new Error("Executable build failed")
await rm(join(destination, "assets"), { recursive: true, force: true })
await cp(
  join(root, "packages/ui-opentui-react/assets/parsers"),
  join(destination, "assets/parsers"),
  { recursive: true },
)
for (const asset of getNodeAssets({
  platform: process.platform as "darwin" | "linux",
  arch: process.arch as "arm64" | "x64",
})) {
  const target = join(destination, "assets/opentui", asset.key)
  await mkdir(dirname(target), { recursive: true })
  await cp(asset.source, target)
}
await mkdir(join(destination, "share/man/man1"), { recursive: true })
await cp(
  join(root, "docs/man/vimex.1"),
  join(destination, "share/man/man1/vimex.1"),
)
await cp(join(root, "LICENSE"), join(destination, "LICENSE"))
// Include dependency notices, including the native renderer's vendored licenses.
const notices = join(destination, "share/licenses")
await mkdir(notices, { recursive: true })
async function collect(directory: string, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name),
      name = join(relative, entry.name)
    if (entry.isDirectory()) await collect(path, name)
    else if (
      /^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|PATENTS)([-.]|$)/i.test(
        entry.name,
      )
    ) {
      const target = join(notices, name)
      await mkdir(dirname(target), { recursive: true })
      await cp(path, target)
    }
  }
}
await collect(join(root, "node_modules/.bun"))
console.log(destination)

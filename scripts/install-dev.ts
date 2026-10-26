import { lstat, mkdir, readlink, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== "--prefix"))
  throw new Error("Usage: bun run install:dev [--prefix PATH]")

const root = resolve(import.meta.dir, "..")
const prefix = resolve(args[1] ?? join(homedir(), ".local"))
const bundle = join(prefix, "share/vimex-dev")
const executable = join(bundle, "vimex")
const launcher = join(prefix, "bin/vimex-dev")

async function existingLauncher(): Promise<boolean> {
  const entry = await lstat(launcher).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return false
  if (
    !entry.isSymbolicLink() ||
    resolve(dirname(launcher), await readlink(launcher)) !== executable
  )
    throw new Error(`Refusing to replace an unrelated launcher: ${launcher}`)
  return true
}

await existingLauncher()
const build = Bun.spawn(
  [
    process.execPath,
    join(root, "scripts/release/build.ts"),
    "--outdir",
    bundle,
  ],
  { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
)
if (await build.exited) throw new Error("Development build failed")

await mkdir(dirname(launcher), { recursive: true })
if (!(await existingLauncher())) await symlink(executable, launcher)
console.log(`Installed ${launcher}. Run vimex-dev from any project directory.`)
if (
  !(process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => resolve(directory) === dirname(launcher))
)
  console.log(`Add ${dirname(launcher)} to your shell's PATH.`)

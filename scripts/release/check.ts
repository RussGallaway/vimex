import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const args = process.argv.slice(2)
const usage = "Usage: bun run check:release [--outdir PATH]"
if (args.length && (args.length !== 2 || args[0] !== "--outdir" || !args[1]))
  throw new Error(usage)
const { version, packageManager } = await Bun.file(
  join(root, "package.json"),
).json()
if (packageManager !== `bun@${Bun.version}`)
  throw new Error(
    `Use ${packageManager} to match CI; running bun@${Bun.version}`,
  )
if (
  !["darwin", "linux"].includes(process.platform) ||
  !["arm64", "x64"].includes(process.arch) ||
  (process.platform === "linux" && process.env.OPENTUI_LIBC === "musl")
)
  throw new Error("Release checks require macOS or glibc Linux on ARM64 or x64")

const env = {
  ...process.env,
  HUSKY: "0",
  HERDR_ENV: "0",
  TERM: "xterm-256color",
}
async function run(
  label: string,
  command: string[],
  cwd = root,
  extraEnv: Record<string, string> = {},
) {
  console.log(`\nRelease check: ${label}`)
  const child = Bun.spawn(command, {
    cwd,
    env: { ...env, ...extraEnv },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`)
}

let temporary: string | undefined
try {
  await run("Python 3.12 and visual dependencies", [
    "python3",
    "-c",
    'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12 to match CI"; import pyte, wcwidth, PIL; print("Python and visual dependencies ready")',
  ]).catch((error) => {
    throw new Error(
      `${error.message}. Use a Python 3.12 virtual environment and install tests/terminal/requirements-live.txt (see docs/releasing.md).`,
    )
  })
  await run("complete repository gate", [process.execPath, "run", "check"])
  await run("diff whitespace", ["git", "diff", "--check"])

  temporary = await mkdtemp(join(tmpdir(), "vimex-release-check-"))
  const output = args[1] ? resolve(args[1]) : join(temporary, "artifacts")
  const name = `vimex-v${version}-${process.platform}-${process.arch}`
  const bundle = join(output, name)
  const unpacked = join(temporary, "unpacked")
  const frames = join(output, "frames")
  console.log(`Release check artifacts: ${output}`)
  await run("native executable and assets", [
    process.execPath,
    join(root, "scripts/release/build.ts"),
    "--outdir",
    bundle,
  ])
  await run("archive and checksum", [
    process.execPath,
    join(root, "scripts/release/package.ts"),
    "--outdir",
    output,
  ])
  const archive = join(output, `${name}.tar.gz`)
  const metadata = await Bun.file(join(output, `${name}.json`)).json()
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex")
  if (
    metadata.version !== version ||
    metadata.artifacts.length !== 1 ||
    metadata.artifacts[0].name !== `${name}.tar.gz` ||
    metadata.artifacts[0].platform !== process.platform ||
    metadata.artifacts[0].arch !== process.arch ||
    metadata.artifacts[0].sha256 !== checksum
  )
    throw new Error("Archive metadata or checksum mismatch")
  await mkdir(unpacked)
  await run("extract release archive", ["tar", "-xzf", archive, "-C", unpacked])
  const binary = join(unpacked, "vimex")
  await run("packaged CLI", [
    process.execPath,
    join(root, "tests/install/cli-smoke.ts"),
    binary,
  ])
  const syntax = join(unpacked, "syntax-smoke")
  await run("compile offline syntax probe", [
    process.execPath,
    "build",
    "--compile",
    "--target=bun",
    "--define",
    "VIMEX_COMPILED=true",
    join(root, "tests/install/syntax-smoke.ts"),
    "--outfile",
    syntax,
  ])
  await run("packaged native, worker, and parser assets", [syntax], temporary)
  await run(
    "packaged TUI visual probe",
    ["python3", join(root, "tests/terminal/visual-driver.py")],
    temporary,
    { VIMEX_TEST_BINARY: binary, VIMEX_TEST_ARTIFACTS_DIR: frames },
  )
  await run(
    "packaged resume routing",
    ["python3", join(root, "tests/install/resume-smoke.py"), binary],
    temporary,
  )
  await rm(temporary, { recursive: true, force: true })
  temporary = undefined
  console.log(
    `\nRelease checks passed for ${process.platform}/${process.arch}.`,
  )
  if (args[1])
    console.log(`Archives, metadata, and frames retained in ${output}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (temporary) console.error(`Failure diagnostics retained in ${temporary}`)
  process.exitCode = 1
}

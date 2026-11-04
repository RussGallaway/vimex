// Exercise the real bootstrap against unpublished bytes in an isolated prefix.
// Only download uses GitHub; the installer sees a strict local curl fixture.
import { execFileSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  compareVersions,
  normalizeVersion,
  parseRelease,
  releaseArtifact,
} from "@vimex/distribution"

const root = resolve(import.meta.dir, "../..")
const directory = resolve(process.argv[2] ?? "dist")
const { version } = await Bun.file(join(root, "package.json")).json()
const name = `vimex-v${version}-${process.platform}-${process.arch}`
const fragment = parseRelease(
  await Bun.file(join(directory, `${name}.json`)).json(),
)
const artifact = releaseArtifact(fragment, process.platform, process.arch)
const temporary = await mkdtemp(join(tmpdir(), "vimex-install-smoke-"))
const repo = "RussGallaway/vimex"
async function run(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`${command[0]} failed (${code}): ${err}\n${out}`)
  return out.trim()
}
try {
  const fixture = join(temporary, "fixture")
  await mkdir(fixture)
  await writeFile(
    join(fixture, "curl"),
    `#!/bin/sh
out=''; url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; out=$1;; https://*) url=$1;; esac
  shift
done
base="https://github.com/RussGallaway/vimex/releases/download/v$SMOKE_VERSION"
case "$url" in
  "$base/SHA256SUMS") cp "$SMOKE_SUMS" "$out";;
  "$base/$SMOKE_NAME") cp "$SMOKE_ARCHIVE" "$out";;
  *) printf 'Unexpected install URL %s\\n' "$url" >&2; exit 70;;
esac
`,
  )
  await chmod(join(fixture, "curl"), 0o755)
  const sums = join(temporary, "candidate-sums")
  await writeFile(sums, `${artifact.sha256}  ${artifact.name}\n`)
  async function install(
    prefix: string,
    expected: string,
    archive: string,
    checksumFile: string,
  ) {
    const installRoot = join(temporary, prefix, "root")
    const bin = join(temporary, prefix, "bin")
    await run(["sh", join(root, "install.sh"), expected], {
      ...process.env,
      HERDR_ENV: "0",
      PATH: `${fixture}:${process.env.PATH}`,
      VIMEX_INSTALL_ROOT: installRoot,
      VIMEX_BIN_DIR: bin,
      SMOKE_VERSION: expected,
      SMOKE_NAME: `vimex-v${expected}-${process.platform}-${process.arch}.tar.gz`,
      SMOKE_ARCHIVE: archive,
      SMOKE_SUMS: checksumFile,
    })
    const binary = join(bin, "vimex")
    if ((await run([binary, "--version"])) !== `vimex ${expected}`)
      throw new Error("Installed executable version mismatch")
    if (!(await run([binary, "--help"])).includes("resume"))
      throw new Error("Installed CLI help missing")
    const receipt = JSON.parse(
      await readFile(join(installRoot, ".vimex-install.json"), "utf8"),
    )
    if (receipt.version !== expected)
      throw new Error("Installed receipt version mismatch")
    await readFile(join(installRoot, "current/share/man/man1/vimex.1"))
    return { installRoot, target: await readlink(join(installRoot, "current")) }
  }
  await install("clean", version, join(directory, artifact.name), sums)
  const releases: { tag_name: string; draft: boolean; prerelease: boolean }[] =
    JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/releases?per_page=100`], {
        encoding: "utf8",
      }),
    )
  const previous = releases
    .filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        compareVersions(normalizeVersion(r.tag_name), version) < 0,
    )
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]
  if (!previous)
    throw new Error(
      "No preceding stable release available for the required upgrade probe",
    )
  const priorVersion = normalizeVersion(previous.tag_name)
  const prior = join(temporary, "previous")
  await mkdir(prior)
  const priorName = `vimex-v${priorVersion}-${process.platform}-${process.arch}.tar.gz`
  await run([
    "gh",
    "release",
    "download",
    previous.tag_name,
    "--repo",
    repo,
    "--pattern",
    priorName,
    "--pattern",
    "SHA256SUMS",
    "--dir",
    prior,
  ])
  const installed = await install(
    "upgrade",
    priorVersion,
    join(prior, priorName),
    join(prior, "SHA256SUMS"),
  )
  const upgraded = await install(
    "upgrade",
    version,
    join(directory, artifact.name),
    sums,
  )
  if (installed.target === upgraded.target)
    throw new Error("Upgrade did not switch versions")
  await readFile(join(installed.installRoot, installed.target, "vimex"))
  console.log(
    `Clean install and ${priorVersion} -> ${version} upgrade passed for ${process.platform}/${process.arch}`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}

import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join, relative, sep } from "node:path"
import {
  normalizeVersion,
  type Release,
  type ReleaseArtifact,
} from "@vimex/distribution"
import { runProcess, type RunProcess } from "./homebrew"

export interface DirectInstallerOptions {
  download(version: string, name: string): Promise<Uint8Array>
  run?: RunProcess
}
/** A versioned bundle is staged beside current; a single symlink rename commits it. */
export async function installDirect(
  release: Release,
  artifact: ReleaseArtifact,
  root: string,
  options: DirectInstallerOptions,
): Promise<{ warning?: string }> {
  normalizeVersion(release.version)
  const receipt = JSON.parse(
    await readFile(join(root, ".vimex-install.json"), "utf8"),
  ) as { schemaVersion?: unknown; kind?: unknown }
  if (receipt.schemaVersion !== 1 || receipt.kind !== "direct")
    throw new Error(
      "Refusing to replace an installation without a direct-install receipt",
    )
  const current = await lstat(join(root, "current"))
  if (!current.isSymbolicLink())
    throw new Error("Direct installation current path must be a symlink")
  const run = options.run ?? runProcess
  const versions = join(root, "versions")
  const versionsStat = await lstat(versions)
  if (!versionsStat.isDirectory() || versionsStat.isSymbolicLink())
    throw new Error("Direct installation versions must be a real directory")
  const actualRoot = await realpath(root)
  const actualVersions = await realpath(versions)
  const actualCurrent = await realpath(join(root, "current"))
  if (
    actualVersions !== join(actualRoot, "versions") ||
    !relative(actualVersions, actualCurrent) ||
    relative(actualVersions, actualCurrent).startsWith("..") ||
    relative(actualVersions, actualCurrent).includes(sep)
  )
    throw new Error(
      "Direct installation current bundle is outside its owned versions directory",
    )
  const lock = join(root, ".upgrade-lock")
  try {
    await mkdir(lock)
  } catch {
    throw new Error(
      "Another upgrade is running, or a previous upgrade left .upgrade-lock; inspect it before retrying",
    )
  }
  let stage: string | undefined,
    replacement: string | undefined,
    bundle: string | undefined
  let committed = false
  try {
    const bytes = await options.download(release.version, artifact.name)
    const checksum = createHash("sha256").update(bytes).digest("hex")
    if (checksum !== artifact.sha256.toLowerCase())
      throw new Error(
        "Artifact checksum mismatch; installation was not changed",
      )
    stage = await mkdtemp(join(versions, ".stage-"))
    const archive = join(stage, "release.tar.gz")
    await writeFile(archive, bytes)
    const listing = await run("tar", ["-tzf", archive])
    const details = await run("tar", ["-tvzf", archive])
    if (listing.code !== 0 || details.code !== 0)
      throw new Error("Cannot inspect release archive")
    const paths = listing.stdout.split("\n").filter(Boolean)
    if (
      !paths.length ||
      paths.some(
        (path) =>
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes(".."),
      )
    )
      throw new Error("Unsafe path in release archive")
    const allowedRoots = ["vimex", "LICENSE", "assets", "share"]
    if (
      paths.some((path) => {
        const normalized = path.replace(/^\.\//, "").replace(/\/$/, "")
        return (
          normalized !== "" &&
          !allowedRoots.some(
            (root) => normalized === root || normalized.startsWith(`${root}/`),
          )
        )
      })
    )
      throw new Error("Unexpected path in release archive")
    if (
      details.stdout
        .split("\n")
        .filter(Boolean)
        .some((line) => !/^[d-]/.test(line))
    )
      throw new Error("Release archive contains links or special files")
    if (!paths.some((path) => path.replace(/^\.\//, "") === "vimex"))
      throw new Error("Release archive is missing vimex")
    const extracted = await run(
      "tar",
      ["-xzf", archive, "--no-same-owner", "--no-same-permissions"],
      { cwd: stage },
    )
    if (extracted.code !== 0)
      throw new Error(`Cannot extract release archive: ${extracted.stderr}`)
    await rm(archive)
    const executable = join(stage, "vimex")
    const executableStat = await lstat(executable)
    const actual = await realpath(executable)
    if (
      !executableStat.isFile() ||
      relative(await realpath(stage), actual).startsWith(`..${sep}`)
    )
      throw new Error("Invalid release executable")
    const [assetsStat, manualStat] = await Promise.all([
      lstat(join(stage, "assets")),
      lstat(join(stage, "share", "man", "man1", "vimex.1")),
    ]).catch(() => {
      throw new Error("Incomplete release archive")
    })
    if (
      !assetsStat.isDirectory() ||
      assetsStat.isSymbolicLink() ||
      !manualStat.isFile() ||
      manualStat.isSymbolicLink()
    )
      throw new Error("Incomplete release archive")
    await chmod(executable, 0o755)
    bundle = join(
      versions,
      `${release.version}-${artifact.platform}-${artifact.arch}-${randomUUID().slice(0, 8)}`,
    )
    await rename(stage, bundle)
    stage = undefined
    replacement = join(root, `.current-${randomUUID()}`)
    await symlink(relative(root, bundle), replacement)
    await rename(replacement, join(root, "current"))
    replacement = undefined
    committed = true
    // Provenance remains valid even if this informational version refresh fails.
    const receiptPath = join(root, `.receipt-${randomUUID()}`)
    let warning: string | undefined
    try {
      await writeFile(
        receiptPath,
        JSON.stringify({
          schemaVersion: 1,
          kind: "direct",
          version: release.version,
        }) + "\n",
      )
      await rename(receiptPath, join(root, ".vimex-install.json"))
    } catch {
      warning =
        "The new version is active, but the installation receipt version could not be refreshed."
    } finally {
      await rm(receiptPath, { force: true }).catch(() => {})
    }
    return warning ? { warning } : {}
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    if (replacement) await rm(replacement, { force: true })
    if (bundle && !committed) await rm(bundle, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

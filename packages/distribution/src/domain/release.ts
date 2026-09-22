export type ReleasePlatform = "darwin" | "linux"
export type ReleaseArchitecture = "arm64" | "x64"
export interface ReleaseArtifact {
  platform: ReleasePlatform
  arch: ReleaseArchitecture
  name: string
  sha256: string
}
export interface Release {
  version: string
  artifacts: readonly ReleaseArtifact[]
}
/** Release artifact versions use SemVer without build metadata. */
export function normalizeVersion(value: string): string {
  const version = value.replace(/^v/, "")
  if (version.includes("+"))
    throw new Error("Build metadata is not supported in release versions")
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    )
  if (
    !match ||
    match[4]
      ?.split(".")
      .some(
        (identifier) =>
          /^[0-9]+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0"),
      )
  )
    throw new Error(`Invalid release version: ${value}`)
  return version
}

/** SemVer precedence, including numeric prereleases and arbitrarily large components. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string) => {
    const version = normalizeVersion(value)
    const delimiter = version.indexOf("-")
    const core = delimiter === -1 ? version : version.slice(0, delimiter)
    return {
      core: core.split(".").map(BigInt),
      prerelease:
        delimiter === -1 ? [] : version.slice(delimiter + 1).split("."),
    }
  }
  const a = parse(left),
    b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a.core[index]! < b.core[index]!) return -1
    if (a.core[index]! > b.core[index]!) return 1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index++
  ) {
    const x = a.prerelease[index],
      y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^[0-9]+$/.test(x),
      yNumeric = /^[0-9]+$/.test(y)
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
export function releaseArtifact(
  release: Release,
  platform: string,
  arch: string,
): ReleaseArtifact {
  const artifact = release.artifacts.find(
    (value) => value.platform === platform && value.arch === arch,
  )
  if (!artifact)
    throw new Error(
      `No Vimex ${release.version} release for ${platform}/${arch}`,
    )
  return artifact
}
export function parseRelease(value: unknown): Release {
  if (!value || typeof value !== "object")
    throw new Error("Invalid release manifest")
  const record = value as Record<string, unknown>
  if (typeof record.version !== "string" || !Array.isArray(record.artifacts))
    throw new Error("Invalid release manifest")
  const version = normalizeVersion(record.version)
  const artifacts = record.artifacts.map((entry: unknown): ReleaseArtifact => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid release artifact")
    const artifact = entry as Record<string, unknown>
    if (
      (artifact.platform !== "darwin" && artifact.platform !== "linux") ||
      (artifact.arch !== "arm64" && artifact.arch !== "x64") ||
      typeof artifact.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(artifact.name) ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256)
    )
      throw new Error("Invalid release artifact")
    return {
      platform: artifact.platform,
      arch: artifact.arch,
      name: artifact.name,
      sha256: artifact.sha256.toLowerCase(),
    }
  })
  const keys = artifacts.map(
    (artifact) => `${artifact.platform}/${artifact.arch}`,
  )
  if (new Set(keys).size !== keys.length)
    throw new Error("Duplicate platform in release manifest")
  return { version, artifacts }
}

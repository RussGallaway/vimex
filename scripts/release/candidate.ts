import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseRelease } from "@vimex/distribution"

export const targets = ["darwin-arm64", "linux-arm64", "linux-x64"] as const
export const candidateFiles = (version: string) => [
  ...targets.map((target) => `vimex-v${version}-${target}.tar.gz`),
  "vimex-release.json",
  "SHA256SUMS",
  "vimex.rb",
  "install.sh",
]
export type CandidateIdentity = {
  sha: string
  version: string
  runId: string
  runAttempt: string
}
function validateIdentity(value: CandidateIdentity) {
  if (
    !/^[a-f0-9]{40}$/.test(value.sha) ||
    !/^\d+$/.test(value.runId) ||
    !/^[1-9]\d*$/.test(value.runAttempt)
  )
    throw new Error("Invalid candidate commit or workflow identity")
}
async function hashes(directory: string, version: string) {
  const entries = await Promise.all(
    candidateFiles(version).map(async (name) => {
      if (!(await lstat(join(directory, name))).isFile())
        throw new Error(`Candidate must contain regular files: ${name}`)
      return [
        name,
        createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex"),
      ] as const
    }),
  )
  const result = Object.fromEntries(entries)
  const release = parseRelease(
    JSON.parse(await readFile(join(directory, "vimex-release.json"), "utf8")),
  )
  if (
    release.version !== version ||
    release.artifacts.length !== targets.length ||
    release.artifacts.some(
      (a) =>
        !targets.includes(
          `${a.platform}-${a.arch}` as (typeof targets)[number],
        ) ||
        a.name !== `vimex-v${version}-${a.platform}-${a.arch}.tar.gz` ||
        result[a.name] !== a.sha256,
    )
  )
    throw new Error("Candidate manifest does not match supported archives")
  const sums = release.artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join("")
  if ((await readFile(join(directory, "SHA256SUMS"), "utf8")) !== sums)
    throw new Error("Candidate checksums do not match manifest")
  return result
}
export async function prepareCandidate(
  directory: string,
  identity: CandidateIdentity,
) {
  validateIdentity(identity)
  const files = await hashes(directory, identity.version)
  await writeFile(
    join(directory, "candidate.json"),
    JSON.stringify({ schemaVersion: 1, ...identity, files }, null, 2) + "\n",
  )
}
export async function verifyCandidate(
  directory: string,
  identity: CandidateIdentity,
) {
  validateIdentity(identity)
  const receipt = JSON.parse(
    await readFile(join(directory, "candidate.json"), "utf8"),
  )
  if (
    receipt.schemaVersion !== 1 ||
    Object.entries(identity).some(([key, value]) => receipt[key] !== value)
  )
    throw new Error(
      "Candidate identity differs from the tag or successful workflow run",
    )
  const expected = [
    ...candidateFiles(identity.version),
    "candidate.json",
  ].sort()
  if (
    JSON.stringify((await readdir(directory)).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error("Unexpected or missing candidate files")
  const actual = await hashes(directory, identity.version)
  if (
    !receipt.files ||
    JSON.stringify(Object.keys(receipt.files).sort()) !==
      JSON.stringify(Object.keys(actual).sort()) ||
    Object.entries(actual).some(([name, hash]) => receipt.files[name] !== hash)
  )
    throw new Error("Candidate checksum mismatch")
}
if (import.meta.main) {
  const [mode, directory = "dist"] = process.argv.slice(2)
  const { version } = await Bun.file(
    new URL("../../package.json", import.meta.url),
  ).json()
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  const identity = {
    sha,
    version,
    runId: process.env.CANDIDATE_RUN_ID ?? process.env.GITHUB_RUN_ID ?? "",
    runAttempt:
      process.env.CANDIDATE_RUN_ATTEMPT ?? process.env.GITHUB_RUN_ATTEMPT ?? "",
  }
  if (mode === "prepare") await prepareCandidate(resolve(directory), identity)
  else if (mode === "verify") {
    if (process.env.GITHUB_REF !== `refs/tags/v${version}`)
      throw new Error("Promotion requires a tag matching the candidate version")
    await verifyCandidate(resolve(directory), identity)
  } else throw new Error("Usage: candidate.ts prepare|verify [DIRECTORY]")
}

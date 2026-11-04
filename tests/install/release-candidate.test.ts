import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  candidateFiles,
  prepareCandidate,
  verifyCandidate,
  type CandidateIdentity,
} from "../../scripts/release/candidate"
import {
  trustedRun,
  selectArtifact,
  candidateName,
  type CandidateRun,
} from "../../scripts/release/select-candidate"
const identity: CandidateIdentity = {
  sha: "a".repeat(40),
  version: "1.2.3",
  runId: "123",
  runAttempt: "2",
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vimex-candidate-"))
  const artifacts = []
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ]) {
    const name = `vimex-v${identity.version}-${platform}-${arch}.tar.gz`
    const bytes = Buffer.from(name)
    await writeFile(join(directory, name), bytes)
    artifacts.push({
      name,
      platform,
      arch,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
  await writeFile(
    join(directory, "vimex-release.json"),
    JSON.stringify({ version: identity.version, artifacts }),
  )
  await writeFile(
    join(directory, "SHA256SUMS"),
    artifacts.map((a) => `${a.sha256}  ${a.name}\n`).join(""),
  )
  await writeFile(join(directory, "vimex.rb"), "fixture formula")
  await writeFile(join(directory, "install.sh"), "fixture installer")
  await prepareCandidate(directory, identity)
  return directory
}
test("candidate promotion binds every distributed file to the exact commit and successful attempt", async () => {
  const directory = await fixture()
  try {
    await verifyCandidate(directory, identity)
    for (const change of [
      { sha: "b".repeat(40) },
      { version: "1.2.4" },
      { runId: "456" },
      { runAttempt: "3" },
    ])
      await expect(
        verifyCandidate(directory, { ...identity, ...change }),
      ).rejects.toThrow("identity")
    for (const file of candidateFiles(identity.version)) {
      const original = await readFile(join(directory, file))
      await writeFile(join(directory, file), "tampered")
      await expect(verifyCandidate(directory, identity)).rejects.toThrow()
      await writeFile(join(directory, file), original)
    }
    await writeFile(join(directory, "unexpected.tar.gz"), "extra")
    await expect(verifyCandidate(directory, identity)).rejects.toThrow(
      "Unexpected",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("candidate preparation refuses incomplete or mismatched platform archives", async () => {
  const directory = await fixture()
  try {
    await rm(join(directory, candidateFiles(identity.version)[0]!))
    await expect(prepareCandidate(directory, identity)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("only completed successful same-repository main runs may supply a candidate", () => {
  const repo = "RussGallaway/vimex"
  const run: CandidateRun = {
    id: 123,
    head_sha: identity.sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    head_repository: { full_name: repo },
  }
  expect(trustedRun(run, identity.sha, repo)).toBe(true)
  expect(
    trustedRun({ ...run, event: "workflow_dispatch" }, identity.sha, repo),
  ).toBe(true)
  for (const change of [
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { head_repository: null },
    { head_repository: { full_name: "someone/fork" } },
    { run_attempt: 0 },
  ])
    expect(trustedRun({ ...run, ...change }, identity.sha, repo)).toBe(false)
})

test("promotion refuses expired artifacts and candidates from a different attempt or commit", () => {
  const valid = { id: 42, name: candidateName(identity.sha, 2), expired: false }
  expect(selectArtifact([valid], identity.sha, 2)).toEqual(valid)
  expect(
    selectArtifact([{ ...valid, expired: true }], identity.sha, 2),
  ).toBeUndefined()
  expect(selectArtifact([valid], identity.sha, 3)).toBeUndefined()
  expect(selectArtifact([valid], "b".repeat(40), 2)).toBeUndefined()
  expect(
    selectArtifact([{ ...valid, id: -1 }], identity.sha, 2),
  ).toBeUndefined()
})

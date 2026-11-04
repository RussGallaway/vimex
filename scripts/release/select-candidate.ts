import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
export type CandidateRun = {
  id: number
  head_sha: string
  head_branch: string
  event: string
  status: string
  conclusion: string
  run_attempt: number
  head_repository: { full_name: string } | null
}
export function trustedRun(run: CandidateRun, sha: string, repository: string) {
  return (
    run.head_sha === sha &&
    run.head_branch === "main" &&
    run.head_repository?.full_name === repository &&
    ["push", "workflow_dispatch"].includes(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  )
}
export function candidateName(sha: string, attempt: number) {
  return `release-candidate-${sha}-${attempt}`
}
export type CandidateArtifact = { id: number; name: string; expired: boolean }
export function selectArtifact(
  artifacts: CandidateArtifact[],
  sha: string,
  attempt: number,
) {
  return artifacts.find(
    (a) =>
      a.name === candidateName(sha, attempt) &&
      !a.expired &&
      Number.isSafeInteger(a.id) &&
      a.id > 0,
  )
}
if (import.meta.main) {
  const readiness = process.argv[2] === "--check"
  const repository =
    process.env.GITHUB_REPOSITORY ?? (readiness ? "RussGallaway/vimex" : "")
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid repository")
  if (
    readiness &&
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw new Error(
      "Commit the intended release changes before checking candidate readiness",
    )
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  const { version } = await Bun.file(
    new URL("../../package.json", import.meta.url),
  ).json()
  if (!readiness && process.env.GITHUB_REF !== `refs/tags/v${version}`)
    throw new Error("Release must run on a version tag matching package.json")
  const api = (path: string) =>
    JSON.parse(
      execFileSync("gh", ["api", "--paginate", "--slurp", path], {
        encoding: "utf8",
      }),
    )
  const pages = api(
    `repos/${repository}/actions/workflows/check.yml/runs?head_sha=${sha}&status=success&per_page=100`,
  )
  for (const run of pages.flatMap(
    (page: { workflow_runs: CandidateRun[] }) => page.workflow_runs,
  )) {
    if (!trustedRun(run, sha, repository)) continue
    const artifacts = api(
      `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    ).flatMap(
      (page: { artifacts: { id: number; name: string; expired: boolean }[] }) =>
        page.artifacts,
    )
    const artifact = selectArtifact(artifacts, sha, run.run_attempt)
    if (!artifact) continue
    if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0)
      throw new Error("Invalid artifact ID")
    if (!readiness)
      await appendFile(
        process.env.GITHUB_OUTPUT!,
        `run_id=${run.id}\nrun_attempt=${run.run_attempt}\nartifact_id=${artifact.id}\n`,
      )
    console.log(
      `Verified candidate ready at https://github.com/${repository}/actions/runs/${run.id}`,
    )
    process.exit(0)
  }
  throw new Error(
    `No successful, unexpired main-branch candidate for ${sha}. Run Checks for this exact commit before tagging; release never rebuilds.`,
  )
}

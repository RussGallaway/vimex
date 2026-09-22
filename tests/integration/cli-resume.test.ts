import { expect, test } from "bun:test"
import { join } from "node:path"

test("real CLI resume modes select existing sessions without creating or sending", async () => {
  const child = Bun.spawn(
    ["python3", join(import.meta.dir, "../install/resume-smoke.py")],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(`CLI resume acceptance failed: ${stderr}\n${stdout}`)
  const report = JSON.parse(stdout)
  expect(report.passed).toBe(true)
  expect(report.checks).toEqual(["resume side-main", "resume --last", "resume"])
}, 45_000)

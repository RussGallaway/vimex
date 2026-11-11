import { expect, test } from "bun:test"
import { join } from "node:path"

test("Rex pane restoration reopens exact conversations with independent drafts", async () => {
  const child = Bun.spawn(
    ["python3", join(import.meta.dir, "../install/rex-restore-smoke.py")],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(`Rex restore acceptance failed: ${stderr}\n${stdout}`)
  expect(JSON.parse(stdout).passed).toBe(true)
}, 60_000)

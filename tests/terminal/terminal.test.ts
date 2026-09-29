import { test, expect } from "bun:test"
import { join } from "node:path"

test("real PTY: full screen, Markdown, draft editing, Vim modes, and terminal restoration", async () => {
  const process = Bun.spawn(["python3", join(import.meta.dir, "driver.py")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0)
    throw new Error(`PTY integration failed: ${stderr}\n${stdout}`)
  expect(JSON.parse(stdout).passed).toBe(true)
}, 30000)

test("real PTY: Telescope picker opens without exhausting native resources", async () => {
  const process = Bun.spawn(
    ["python3", join(import.meta.dir, "driver.py"), "picker"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0)
    throw new Error(`PTY picker integration failed: ${stderr}\n${stdout}`)
  expect(JSON.parse(stdout).checks).toContain("telescope-picker")
}, 30000)

test("real PTY: space-slash grep picker renders a result preview", async () => {
  const process = Bun.spawn(
    ["python3", join(import.meta.dir, "driver.py"), "grep"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0)
    throw new Error(`PTY grep integration failed: ${stderr}\n${stdout}`)
  const checks = JSON.parse(stdout).checks
  expect(checks).toContain("grep-picker")
  expect(checks).toContain("grep-preview")
}, 30000)

test("real PTY and JSONL server: submit, approve, stream completion, and quit", async () => {
  const process = Bun.spawn(
    ["python3", join(import.meta.dir, "driver.py"), "server"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exit !== 0)
    throw new Error(`PTY app-server test failed: ${stderr}\n${stdout}`)
  expect(JSON.parse(stdout).passed).toBe(true)
}, 30000)

for (const scenario of ["signal", "save-failure"]) {
  test(`real PTY restores terminal after ${scenario}`, async () => {
    const process = Bun.spawn(
      ["python3", join(import.meta.dir, "driver.py"), scenario],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exit !== 0)
      throw new Error(`PTY ${scenario} failed: ${stderr}\n${stdout}`)
    expect(JSON.parse(stdout).passed).toBe(true)
  }, 30000)
}

test.skipIf(process.env.VIMEX_TEST_TMUX !== "1" || !Bun.which("tmux"))(
  "isolated tmux: Markdown, Vim input, draft preservation, and quit",
  async () => {
    const process = Bun.spawn(
      ["python3", join(import.meta.dir, "tmux-driver.py")],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exit !== 0)
      throw new Error(`tmux integration failed: ${stderr}\n${stdout}`)
    expect(JSON.parse(stdout).passed).toBe(true)
  },
  30000,
)

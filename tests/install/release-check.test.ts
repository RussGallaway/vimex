import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../../scripts/release/check.ts")

test("release checks reject unsupported arguments before running tests or builds", async () => {
  for (const args of [["--skip-check"], ["--outdir"], ["--outdir", ""]]) {
    const child = Bun.spawn([process.execPath, script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(error).toContain("Usage:")
    expect(output).not.toContain("Release check:")
  }
})

test("a failed prerequisite aborts release checks before the repository gate or packaging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-release-prerequisite-"))
  try {
    const python = join(directory, "python3")
    await writeFile(python, "#!/bin/sh\nexit 17\n")
    await chmod(python, 0o755)
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, PATH: directory },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(error).toContain("exit 17")
    expect(error).toContain("requirements-live.txt")
    expect(output).not.toContain("complete repository gate")
    expect(output).not.toContain("native executable and assets")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

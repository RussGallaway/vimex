import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireFileLock, withFileLock } from "./file-lock"

test("OS ownership excludes another process and is released after SIGKILL", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-lock-"))
  const path = join(root, "owner.lock")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { acquireFileLock } from ${JSON.stringify(import.meta.dir + "/file-lock.ts")};
     const release = await acquireFileLock(process.argv[1]);
     if (!release) process.exit(2);
     console.log("locked");
     setInterval(() => {}, 1000);`,
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "locked",
    )
    reader.releaseLock()
    expect(await acquireFileLock(path)).toBeUndefined()
    child.kill("SIGKILL")
    await child.exited
    const release = await acquireFileLock(path)
    expect(release).toBeDefined()
    await release!()
    await release!()
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
})

test("waiting locks do not block the event loop and release after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-lock-wait-"))
  const path = join(root, "owner.lock")
  try {
    const release = await acquireFileLock(path)
    setTimeout(() => void release!(), 25)
    await expect(
      withFileLock(path, async () => {
        throw new Error("failed")
      }),
    ).rejects.toThrow("failed")
    const next = await acquireFileLock(path)
    expect(next).toBeDefined()
    await expect(withFileLock(path, async () => {}, 1)).rejects.toThrow(
      "Timed out",
    )
    await next!()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

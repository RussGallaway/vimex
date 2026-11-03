import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { createDirectoryNavigation } from "./directories"

test("directory navigation validates, expands home, lists spaced children and recovers from invalid base", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-directory-"))
  try {
    await mkdir(join(root, "spaced folder"))
    await writeFile(join(root, "file"), "x")
    await mkdir(join(root, "literal $(touch nope); folder"))
    const port = createDirectoryNavigation()
    const canonical = await port.resolve("/missing-base", root)
    expect(await port.resolve(root, "spaced folder")).toBe(
      `${canonical}/spaced folder`,
    )
    expect(await port.resolve(root, "~")).toBe(
      await port.resolve("/", homedir()),
    )
    const listing = await port.list(root, ".")
    expect(await port.resolve(root, "literal $(touch nope); folder")).toBe(
      `${canonical}/literal $(touch nope); folder`,
    )
    expect(listing.entries).toContainEqual({
      cwd: `${canonical}/spaced folder`,
      label: "spaced folder",
    })
    await expect(port.resolve(root, "missing")).rejects.toThrow(
      "not a directory",
    )
    await expect(port.resolve(root, "file")).rejects.toThrow("not a directory")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

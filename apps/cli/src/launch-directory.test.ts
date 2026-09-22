import { expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveLaunchDirectory } from "./launch-directory"

test("launch directory canonicalizes symlink aliases before cwd-scoped resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-cwd-"))
  try {
    const project = join(directory, "real-project"),
      alias = join(directory, "alias")
    await mkdir(project)
    await symlink(project, alias)
    expect(await resolveLaunchDirectory(alias)).toBe(await realpath(project))
    const file = join(directory, "not-directory")
    await writeFile(file, "file")
    await expect(resolveLaunchDirectory(file)).rejects.toThrow(
      "Not a directory",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

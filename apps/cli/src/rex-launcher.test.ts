import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rexLauncher } from "./rex-launcher"

test("shell integration retains matching installation symlinks and ignores another Vimex build", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-launcher-"))
  try {
    const bin = join(root, "bin")
    await mkdir(bin)
    const executable = join(root, "versioned-vimex")
    await writeFile(executable, "my build")
    await writeFile(join(bin, "vimex"), "another build")
    await symlink(executable, join(bin, "vimex-dev"))
    expect(
      await rexLauncher({
        compiled: true,
        executable,
        entry: "unused",
        invoked: executable,
        path: bin,
      }),
    ).toEqual([join(bin, "vimex-dev")])
    expect(
      await rexLauncher({
        compiled: false,
        executable: "/bun",
        entry: "/repo/main.ts",
        path: bin,
      }),
    ).toEqual(["/bun", "/repo/main.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

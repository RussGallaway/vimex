import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileLinkPreviewLimit, readLocalLinkPreview } from "./file-link-preview"

test("file links preserve lines beyond the short mention-preview prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-link-preview-"))
  try {
    const path = join(root, "source.ts")
    const contents = Array.from(
      { length: 400 },
      (_, i) => `line ${i + 1} ${"x".repeat(24)}`,
    ).join("\n")
    await writeFile(path, contents)
    expect(await readLocalLinkPreview(path)).toBe(contents)
    expect((await readLocalLinkPreview(path))?.split("\n")[299]).toStartWith(
      "line 300 ",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file link previews refuse oversized and binary files and honor cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-link-preview-"))
  try {
    const path = join(root, "data")
    await writeFile(path, "binary\0data")
    expect(await readLocalLinkPreview(path)).toBeUndefined()
    await truncate(path, fileLinkPreviewLimit + 1)
    expect(await readLocalLinkPreview(path)).toBeUndefined()
    expect(await readLocalLinkPreview(root)).toBeUndefined()
    const abort = new AbortController()
    abort.abort()
    await expect(readLocalLinkPreview(path, abort.signal)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClipboardService } from "@opentui/core"
import { emptyLocalState } from "@vimex/workbench"
import { imageInput } from "./images"

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
    "base64",
  ),
)

test("pasted and dropped images are snapshotted before their source disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-images-"))
  try {
    const original = join(root, "source image.png")
    await writeFile(original, png)
    const clipboard = {
      read: async () => ({
        status: "read" as const,
        representation: { mimeType: "image/png", bytes: png },
      }),
    } as unknown as ClipboardService
    const images = imageInput(clipboard, join(root, "owned"))
    const dropped = await images.fromPath(
      `file://${original.replaceAll(" ", "%20")}`,
    )
    await rm(original)
    expect(dropped.label).toBe("source image.png")
    expect(await Bun.file(dropped.path).bytes()).toEqual(png)
    const pasted = await images.fromClipboard()
    expect(pasted?.label).toBe("clipboard image")
    expect(await Bun.file(pasted!.path).bytes()).toEqual(png)
    expect(pasted?.path).not.toBe(dropped.path)
    await images.cleanup({
      ...emptyLocalState(),
      threads: {
        retained: {
          draft: "",
          cursorOffset: 0,
          folded: {},
          viewport: { kind: "tail" },
          surface: "composer",
          images: [{ ...dropped, id: "retained" }],
          outbox: [],
        },
      },
    })
    expect(await Bun.file(dropped.path).exists()).toBe(true)
    expect(await Bun.file(pasted!.path).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects non-image files even with an image extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-images-"))
  try {
    const path = join(root, "fake.png")
    await writeFile(path, "not an image")
    await expect(
      imageInput({} as ClipboardService, join(root, "owned")).fromPath(path),
    ).rejects.toThrow("Unsupported image")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

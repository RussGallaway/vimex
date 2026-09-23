import { mkdir, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ClipboardService } from "@opentui/core"
import { stateDirectory } from "@vimex/platform-node"
import type { LocalState } from "@vimex/workbench"

const maxImageBytes = 20 * 1024 * 1024

export function imageInput(
  clipboard: ClipboardService,
  directory = join(stateDirectory(), "images"),
) {
  const created = new Set<string>()
  return {
    async fromClipboard() {
      const result = await clipboard.read({
        preferredTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      })
      if (result.status === "empty" || result.status === "unsupported")
        return undefined
      if (result.status !== "read")
        throw new Error(`Clipboard image read ${result.status}`)
      return snapshotImage(
        result.representation.bytes,
        "clipboard image",
        directory,
        created,
      )
    },
    async fromPath(rawPath: string) {
      const path = normalizeImagePath(rawPath)
      const file = Bun.file(path)
      if (!(await file.exists()))
        throw new Error(`Image file not found: ${rawPath}`)
      if (file.size > maxImageBytes) throw new Error("Image exceeds 20 MiB")
      return snapshotImage(
        new Uint8Array(await file.arrayBuffer()),
        path.split("/").at(-1) ?? "image",
        directory,
        created,
      )
    },
    async cleanup(state: LocalState) {
      const retained = new Set<string>()
      for (const view of Object.values(state.threads)) {
        for (const image of view.images ?? []) retained.add(image.path)
        for (const message of view.outbox)
          for (const image of message.images ?? []) retained.add(image.path)
      }
      await Promise.all(
        [...created]
          .filter((path) => !retained.has(path))
          .map(async (path) => {
            try {
              await unlink(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error
            }
          }),
      )
    },
  }
}

function normalizeImagePath(raw: string): string {
  let path = raw.trim()
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1)
  if (path.startsWith("file://"))
    path = decodeURIComponent(new URL(path).pathname)
  path = path.replace(/\\ /g, " ")
  if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2))
  return resolve(path)
}

async function snapshotImage(
  bytes: Uint8Array,
  label: string,
  directory: string,
  created: Set<string>,
) {
  if (bytes.length > maxImageBytes) throw new Error("Image exceeds 20 MiB")
  const extension = imageExtension(bytes)
  if (!extension)
    throw new Error("Unsupported image; use PNG, JPEG, GIF, or WebP")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${crypto.randomUUID()}.${extension}`)
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  created.add(path)
  return { label, path }
}

function imageExtension(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes
      .slice(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  )
    return "png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg"
  const header = new TextDecoder().decode(bytes.slice(0, 12))
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "gif"
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "webp"
  return undefined
}

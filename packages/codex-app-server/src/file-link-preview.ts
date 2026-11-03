import { open, stat } from "node:fs/promises"

export const fileLinkPreviewLimit = 2 * 1024 * 1024

/** Return a complete bounded text file, so a requested line never targets a truncated prefix. */
export async function readLocalLinkPreview(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size > fileLinkPreviewLimit)
    return undefined
  const file = await open(path, "r")
  try {
    const current = await file.stat()
    if (!current.isFile() || current.size > fileLinkPreviewLimit)
      return undefined
    const data = Buffer.alloc(fileLinkPreviewLimit + 1)
    let size = 0
    while (size < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(
        data,
        size,
        data.length - size,
        size,
      )
      if (!bytesRead) break
      size += bytesRead
    }
    signal?.throwIfAborted()
    if (size > fileLinkPreviewLimit || data.subarray(0, size).includes(0))
      return undefined
    return data.subarray(0, size).toString("utf8")
  } finally {
    await file.close()
  }
}

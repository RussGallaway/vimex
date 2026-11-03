import { posix } from "node:path"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"

const ignored = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
])

/** Remote paths are never resolved through the laptop's filesystem or cwd. */
export function remotePath(root: string, path: string): string {
  if (!posix.isAbsolute(root))
    throw new Error("Remote workspace requires an absolute path")
  return posix.resolve(root, path)
}

export async function remoteWorkspaceEntries(
  client: CodexAppServerClient,
  root: string,
  signal?: AbortSignal,
): Promise<{ path: string; match_type: "file" | "directory" }[]> {
  const entries: { path: string; match_type: "file" | "directory" }[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > 40 || entries.length >= 20_000) return
    const response = await client.readHostDirectory(directory)
    signal?.throwIfAborted()
    for (const entry of response.entries) {
      signal?.throwIfAborted()
      if (entries.length >= 20_000) break
      // A remote server is authoritative about files, but cannot redirect this
      // traversal with a path masquerading as a child name.
      if (
        !entry.fileName ||
        entry.fileName === "." ||
        entry.fileName === ".." ||
        /[\/\0]/u.test(entry.fileName)
      )
        continue
      const path = remotePath(directory, entry.fileName)
      if (entry.isDirectory) {
        if (ignored.has(entry.fileName)) continue
        const metadata = await client.getHostMetadata(path)
        if (metadata.isSymlink) continue
        entries.push({ path, match_type: "directory" })
        await visit(path, depth + 1)
      } else if (entry.isFile) entries.push({ path, match_type: "file" })
    }
  }
  await visit(remotePath(root, "."), 0)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export async function readRemoteText(
  client: CodexAppServerClient,
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  const response = await client.readHostFile(path, limit)
  signal?.throwIfAborted()
  const data = Buffer.from(response.dataBase64, "base64")
  if (data.length > limit || data.includes(0)) return undefined
  return data.toString("utf8")
}

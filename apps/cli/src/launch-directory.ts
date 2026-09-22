import { realpath, stat } from "node:fs/promises"

/** Canonical cwd matches the path reported by the Codex child process, including macOS /var aliases. */
export async function resolveLaunchDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory())
    throw new Error(`Not a directory: ${path}`)
  return canonical
}

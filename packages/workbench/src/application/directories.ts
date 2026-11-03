export interface DirectoryListing {
  directory: string
  parent?: string
  entries: readonly { cwd: string; label: string }[]
}
/** Directory paths are resolved and validated on the active runtime's host. */
export interface DirectoryNavigation {
  resolve(base: string, path: string): Promise<string>
  list(base: string, path: string): Promise<DirectoryListing>
}
export function directoryArgument(value: string): string {
  const path = value.trim()
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    return path.slice(1, -1)
  return path
}

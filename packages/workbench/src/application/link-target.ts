export type LinkTarget =
  { kind: "web"; url: string } | { kind: "file"; path: string; line?: number }

/** Interpret a displayed Markdown destination without executing a protocol handler. */
export function linkTarget(value: string): LinkTarget {
  if (!value || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid link destination")
  if (/^https?:\/\//i.test(value)) {
    new URL(value)
    return { kind: "web", url: value }
  }
  let path = value
  let fragment = ""
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.hostname && url.hostname !== "localhost")
      throw new Error(
        "File links to another host cannot be opened in this machine",
      )
    if (url.search)
      throw new Error("File links with query parameters are not supported")
    path = decodeURIComponent(url.pathname)
    fragment = url.hash
  } else {
    const fileLocation = /^(?=[^:]*[/.])[^:]+:\d+(?::\d+)?(?:#.*)?$/.test(value)
    if (
      (!fileLocation && /^[a-z][a-z0-9+.-]*:/i.test(value)) ||
      value.startsWith("//")
    )
      throw new Error("Unsupported link protocol")
    const hash = path.indexOf("#")
    if (hash >= 0) {
      fragment = path.slice(hash)
      path = path.slice(0, hash)
    }
    path = decodeURIComponent(path)
  }
  const suffix = /:(\d+)(?::\d+)?$/.exec(path)
  const anchor = /^#L?(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(fragment)
  if (fragment && !anchor)
    throw new Error("Only file line anchors are supported in file previews")
  const line = anchor
    ? Number(anchor[1])
    : suffix
      ? Number(suffix[1])
      : undefined
  if (suffix) path = path.slice(0, suffix.index)
  if (!path || /[\u0000-\u001f\u007f]/.test(path))
    throw new Error("Invalid file link path")
  if (path.startsWith("~"))
    throw new Error("Use an absolute or project-relative path for file links")
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
    throw new Error("Invalid file link line number")
  return { kind: "file", path, ...(line === undefined ? {} : { line }) }
}

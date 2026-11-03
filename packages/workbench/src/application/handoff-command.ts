export function parseHandoffArgument(argument: string): {
  targetId: string
  destinationCwd?: string
  isolated: boolean
} {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+(.*))?$/.exec(
    argument.trim(),
  )
  const usage = "Usage: handoff <name> [--cwd <path> | --isolated]"
  if (!match) throw new Error(usage)
  const option = match[2]?.trim()
  if (!option || option === "--isolated")
    return { targetId: match[1]!, isolated: option === "--isolated" }
  if (!option.startsWith("--cwd ")) throw new Error(usage)
  let path = option.slice(6).trim()
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path)
    } catch {
      throw new Error("Invalid quoted destination path")
    }
  } else if (path.startsWith("'")) {
    if (!path.endsWith("'") || path.length < 2)
      throw new Error("Invalid quoted destination path")
    path = path.slice(1, -1)
  }
  if (!path || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("Enter a destination directory")
  return { targetId: match[1]!, destinationCwd: path, isolated: false }
}

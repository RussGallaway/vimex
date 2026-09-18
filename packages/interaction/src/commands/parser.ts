import { resolveCommandName, type CommandName } from "./registry"

export type ExCommand = { kind: "command"; name: CommandName; argument: string } | { kind: "empty" } | { kind: "unknown"; name: string }
/** The rest of the line is a literal argument; paths, spaces, and URLs are preserved. */
export function parseCommand(line: string): ExCommand {
  const text = line.trim().replace(/^:/, "").trimStart()
  if (!text) return { kind: "empty" }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)!
  const name = resolveCommandName(match[1]!)
  return name ? { kind: "command", name, argument: match[2] ?? "" } : { kind: "unknown", name: match[1]! }
}

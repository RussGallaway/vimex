import { parseGoalCommand } from "./goal-command"
import {
  commandArgumentChoices,
  commandDescriptors,
  resolveCommandName,
  type CommandCompletionOptions,
  type CommandName,
} from "./registry"

export type ExCommand =
  | { kind: "command"; name: CommandName; argument: string }
  | { kind: "empty" }
  | { kind: "unknown"; name: string }
/** The rest of the line is a literal argument; paths, spaces, and URLs are preserved. */
export function parseCommand(line: string): ExCommand {
  const text = line.trim().replace(/^:/, "").trimStart()
  if (!text) return { kind: "empty" }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)!
  const name = resolveCommandName(match[1]!)
  return name
    ? { kind: "command", name, argument: match[2] ?? "" }
    : { kind: "unknown", name: match[1]! }
}

/** Validate syntax before executing an action. Runtime catalogs remain optional. */
export function validateCommand(
  command: Extract<ExCommand, { kind: "command" }>,
  options: CommandCompletionOptions = {},
): string | undefined {
  if (command.name === "goal") {
    const goal = parseGoalCommand(command.argument)
    return goal.kind === "invalid" ? goal.message : undefined
  }
  const descriptor = commandDescriptors[command.name]
  const argument = command.argument.trim()
  const usage = `Usage: :${descriptor.usage}`
  if (!argument) return descriptor.required ? usage : undefined
  if (descriptor.arguments === "none") return usage
  if (descriptor.arguments === "literal") return undefined
  const parts = argument.split(/\s+/)
  if (descriptor.arguments === "model") {
    if (parts.length > 2) return usage
    if (options.models && !options.models.includes(parts[0]!)) return usage
    const efforts = options.modelEfforts?.[parts[0]!]
    return parts[1] && efforts && !efforts.includes(parts[1])
      ? usage
      : undefined
  }
  const choices = commandArgumentChoices(command.name, options)
  return parts.length > 1 || (choices && !choices.includes(argument))
    ? usage
    : undefined
}

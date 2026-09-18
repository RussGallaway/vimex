import { commandCompletions, parseCommand, type CommandCompletionOptions } from "@vimex/interaction"

/** Slash UI reuses the same command vocabulary and literal argument parser as Ex. */
export function slashCommandChoices(text: string, options: CommandCompletionOptions = {}): readonly string[] {
  if (!text.startsWith("/") || text.includes("\n")) return []
  const body = text.slice(1)
  const choices = commandCompletions(body, options).map(value => value.slice(1))
    .filter(value => { const parsed = parseCommand(value); return parsed.kind !== "command" || parsed.name !== "submit" })
  if (choices.length) return choices
  const parsed = parseCommand(body)
  return parsed.kind === "command" && parsed.name !== "submit" ? [body] : []
}

import { commandCompletions, parseCommand } from "@vimex/interaction"

/** Slash UI reuses the same command vocabulary and literal argument parser as Ex. */
export function slashCommandChoices(text: string): readonly string[] {
  if (!text.startsWith("/") || text.includes("\n")) return []
  const body = text.slice(1)
  const choices = commandCompletions(body).map(value => value.slice(1))
  if (choices.length) return choices
  return parseCommand(body).kind === "command" ? [body] : []
}

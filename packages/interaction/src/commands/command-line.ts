import {
  commandArgumentChoices,
  commandNames,
  resolveCommandName,
  type CommandCompletionOptions,
} from "./registry"

export interface CommandHistory {
  entries: readonly string[]
  index: number
  draft: string
}
export const initialCommandHistory = (): CommandHistory => ({
  entries: [],
  index: 0,
  draft: "",
})
export function recordCommand(
  history: CommandHistory,
  value: string,
): CommandHistory {
  const command = value.trim().replace(/^:/, "")
  const entries = command
    ? [...history.entries.filter((entry) => entry !== command), command].slice(
        -100,
      )
    : [...history.entries]
  return { entries, index: entries.length, draft: "" }
}
export function recallCommand(
  history: CommandHistory,
  current: string,
  direction: -1 | 1,
): { history: CommandHistory; value: string } {
  const draft =
    history.index === history.entries.length ? current : history.draft
  const index = Math.min(
    history.entries.length,
    Math.max(0, history.index + direction),
  )
  return {
    history: { ...history, index, draft },
    value: index === history.entries.length ? draft : history.entries[index]!,
  }
}
export function commandCompletions(
  value: string,
  options: CommandCompletionOptions = {},
): readonly string[] {
  const prefix = value.replace(/^:/, "").trimStart()
  if (!/\s/.test(prefix))
    return commandNames
      .filter((name) => name.startsWith(prefix))
      .map((name) => `:${name}`)
  const [spelling = "", argument = "", effort = "", ...extra] =
    prefix.split(/\s+/)
  const name = resolveCommandName(spelling)
  if (!name || extra.length) return []
  if (
    name === "side" &&
    argument === "focus" &&
    prefix.split(/\s+/).length === 3
  ) {
    return ["parent", "side"]
      .filter((choice) => choice.startsWith(effort))
      .map((choice) => `:${spelling} focus ${choice}`)
  }
  if (name === "model" && prefix.split(/\s+/).length >= 3) {
    return (options.modelEfforts?.[argument] ?? [])
      .filter((choice) => choice.startsWith(effort))
      .map((choice) => `:${spelling} ${argument} ${choice}`)
  }
  // Never replace a literal path, title, URL, or a completed extra argument.
  if (prefix.split(/\s+/).length > 2) return []
  return (commandArgumentChoices(name, options) ?? [])
    .filter((choice) => choice.startsWith(argument))
    .map((choice) => `:${spelling} ${choice}`)
}

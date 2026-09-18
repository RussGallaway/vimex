import { commandNames } from "./registry"

export interface CommandHistory { entries: readonly string[]; index: number; draft: string }
export const initialCommandHistory = (): CommandHistory => ({ entries: [], index: 0, draft: "" })
export function recordCommand(history: CommandHistory, value: string): CommandHistory {
  const command = value.trim().replace(/^:/, "")
  const entries = command ? [...history.entries.filter(entry => entry !== command), command].slice(-100) : [...history.entries]
  return { entries, index: entries.length, draft: "" }
}
export function recallCommand(history: CommandHistory, current: string, direction: -1 | 1): { history: CommandHistory; value: string } {
  const draft = history.index === history.entries.length ? current : history.draft
  const index = Math.min(history.entries.length, Math.max(0, history.index + direction))
  return { history: { ...history, index, draft }, value: index === history.entries.length ? draft : history.entries[index]! }
}
export function commandCompletions(value: string, options: {
  models?: readonly string[]
  modelEfforts?: Readonly<Record<string, readonly string[]>>
} = {}): readonly string[] {
  const prefix = value.replace(/^:/, "")
  if (!prefix.includes(" ")) return commandNames.filter(name => name.startsWith(prefix)).map(name => `:${name}`)
  const [name, argument = "", effort = ""] = prefix.split(/\s+/, 3)
  if ((name === "model" || name === "models") && prefix.split(/\s+/).length >= 3) {
    return (options.modelEfforts?.[argument] ?? []).filter(choice => choice.startsWith(effort)).map(choice => `:${name} ${argument} ${choice}`)
  }
  const choices = name === "model" || name === "models" ? options.models ?? [] : name === "yank" ? ["text", "markdown"] : name === "theme" ? ["ember-tide", "nord", "kanagawa"] : []
  return choices.filter(choice => choice.startsWith(argument)).map(choice => `:${name} ${choice}`)
}

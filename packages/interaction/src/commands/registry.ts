/** Ex command vocabulary belongs to interaction, independent of renderer and runtime. */
export const commandNames = ["quit", "sessions", "approvals", "help", "model", "thinking", "cwd", "new", "approve", "reject", "stop", "fork", "fold", "unfold", "yank", "open", "rename"] as const
export type CommandName = typeof commandNames[number]
const aliases: Readonly<Record<string, CommandName>> = { q: "quit", models: "model" }
export function resolveCommandName(value: string): CommandName | undefined {
  return aliases[value] ?? (commandNames.includes(value as CommandName) ? value as CommandName : undefined)
}

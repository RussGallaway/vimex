import type { CommandAction } from "../generated/v0_154_0/v2/CommandAction"

/** Unwrap only a single literal shell payload; never evaluate or reinterpret it. */
export function displayCommand(command: string): string {
  const wrapper = command.match(/^(?:\/(?:[^\s/]+\/)*|)(?:bash|zsh|sh)\s+-(?:lc|cl|c)\s+(?:'([^']*)'|"([^"\\$`]*)")$/u)
  return wrapper ? wrapper[1] ?? wrapper[2] ?? command : command
}

/** Server-supplied action metadata describes intent; raw execution stays separate. */
export function commandTitle(command: string, actions: readonly CommandAction[]): string {
  if (!actions.length) return displayCommand(command)
  return actions.map(action => {
    switch (action.type) {
      case "read": return `Read ${action.path || action.name}`
      case "listFiles": return action.path ? `List files · ${action.path}` : "List files"
      case "search": return ["Search", action.query, action.path].filter(Boolean).join(" · ")
      case "unknown": return displayCommand(action.command || command)
      default: return displayCommand(command)
    }
  }).join(" · ")
}

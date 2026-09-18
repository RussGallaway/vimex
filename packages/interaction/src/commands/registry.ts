/** Ex command vocabulary belongs to interaction, independent of renderer and runtime. */
export const commandNames = ["quit", "sessions", "approvals", "help", "model", "thinking", "cwd", "new", "approve", "reject", "stop", "fork", "fold", "unfold", "yank", "open", "rename", "questions", "agents", "parent", "restart", "theme", "syntax", "submit", "insert", "normal", "visual"] as const
export type CommandName = typeof commandNames[number]
const aliases: Readonly<Record<string, CommandName>> = { q: "quit", models: "model" }
export function resolveCommandName(value: string): CommandName | undefined {
  return aliases[value] ?? (commandNames.includes(value as CommandName) ? value as CommandName : undefined)
}

/** Shared command help, usable by Ex completion and slash menus. */
export const commandDescriptions: Readonly<Record<CommandName, string>> = {
  quit: "Quit Vimex", sessions: "Switch or create a session", approvals: "Review pending approvals", help: "Show keyboard help",
  model: "Choose the model", thinking: "Set reasoning effort", cwd: "Change working directory", new: "Start a new session",
  approve: "Approve the pending request", reject: "Reject the pending request", stop: "Interrupt the active turn", fork: "Fork from a previous message",
  fold: "Collapse transcript details", unfold: "Expand transcript details", yank: "Copy selected transcript text", open: "Open a URL",
  rename: "Rename this session", questions: "Answer pending questions", agents: "Browse subagent sessions", parent: "Return to the parent session",
  restart: "Restart the Codex connection", theme: "Choose a color theme", syntax: "Choose syntax colors", submit: "Send the current draft",
  insert: "Enter Insert mode", normal: "Enter Normal mode", visual: "Select transcript text",
}

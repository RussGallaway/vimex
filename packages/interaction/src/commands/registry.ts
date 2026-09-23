import { themeNames } from "./theme-names"
/** Ex command vocabulary belongs to interaction, independent of renderer and runtime. */
export const commandNames = [
  "quit",
  "sessions",
  "approvals",
  "help",
  "model",
  "thinking",
  "cwd",
  "new",
  "approve",
  "reject",
  "stop",
  "fork",
  "fold",
  "unfold",
  "yank",
  "open",
  "rename",
  "questions",
  "agents",
  "parent",
  "restart",
  "theme",
  "syntax",
  "submit",
  "insert",
  "normal",
  "visual",
  "favorite",
  "follow",
  "tail",
  "compact",
  "side",
  "manual",
  "goal",
] as const
export type CommandName = (typeof commandNames)[number]
const aliases: Readonly<Record<string, CommandName>> = {
  q: "quit",
  models: "model",
  copy: "yank",
  man: "manual",
}
export function resolveCommandName(value: string): CommandName | undefined {
  return (
    aliases[value] ??
    (commandNames.includes(value as CommandName)
      ? (value as CommandName)
      : undefined)
  )
}

/** Shared command help, usable by Ex completion and slash menus. */
export const commandDescriptions: Readonly<Record<CommandName, string>> = {
  quit: "Quit Vimex",
  sessions: "Switch or create a session",
  approvals: "Review pending approvals",
  help: "Show keyboard help",
  model: "Choose the model",
  thinking: "Set reasoning effort",
  cwd: "Change working directory",
  new: "Start a new session",
  approve: "Approve the pending request",
  reject: "Reject the pending request",
  stop: "Interrupt the active turn",
  fork: "Fork from a previous message",
  fold: "Collapse transcript details",
  unfold: "Expand transcript details",
  yank: "Copy selection or current transcript block",
  open: "Open a URL",
  rename: "Rename this session",
  questions: "Answer pending questions",
  agents: "Browse spawned agents in this conversation",
  parent: "Return to the parent session",
  restart: "Restart the Codex connection",
  theme: "Choose a color theme",
  syntax: "Choose syntax colors",
  submit: "Send the current draft",
  insert: "Enter Insert mode",
  normal: "Enter Normal mode",
  visual: "Select transcript text",
  favorite: "Favorite or unfavorite this session",
  follow: "Resume following the transcript tail",
  tail: "Resume following the transcript tail",
  goal: "Set, inspect, pause, resume, complete, or clear a Codex goal",
  manual: "Read the offline Vimex user manual",
  compact: "Compact the active session context",
  side: "Open a forked side chat; close hides it, quit retires it",
}

export interface CommandDescriptor {
  readonly description: string
  /** Canonical Ex spelling, without the leading colon. */
  readonly usage: string
  readonly arguments: "none" | "literal" | "choice" | "model"
  readonly required?: boolean
  readonly choices?: readonly string[]
}
const themes = themeNames
const argumentDescriptors: Partial<
  Record<CommandName, Omit<CommandDescriptor, "description">>
> = {
  goal: {
    usage:
      "goal [show|pause|resume|complete|clear|[set] [--budget tokens] objective]",
    arguments: "literal",
    choices: [
      "show",
      "pause",
      "resume",
      "complete",
      "clear",
      "set",
      "--budget",
    ],
  },
  side: {
    usage:
      "side [question|close|quit|refresh|quote|maximize|focus parent|focus side]",
    arguments: "literal",
    choices: ["close", "quit", "refresh", "quote", "maximize", "focus"],
  },
  sessions: { usage: "sessions [thread-id]", arguments: "literal" },
  help: {
    usage: "help [command]",
    arguments: "choice",
    choices: [...commandNames, ...Object.keys(aliases)],
  },
  model: { usage: "model [model-id] [thinking-level]", arguments: "model" },
  thinking: { usage: "thinking [level]", arguments: "choice" },
  cwd: { usage: "cwd [directory]", arguments: "literal" },
  new: { usage: "new [directory]", arguments: "literal" },
  rename: { usage: "rename <title>", arguments: "literal", required: true },
  open: { usage: "open [url]", arguments: "literal" },
  yank: {
    usage: "yank [text|markdown]",
    arguments: "choice",
    choices: ["text", "markdown"],
  },
  theme: { usage: "theme [name]", arguments: "choice", choices: themes },
  syntax: {
    usage: "syntax [theme|name]",
    arguments: "choice",
    choices: ["theme", ...themes],
  },
  submit: {
    usage: "submit [queue|steer]",
    arguments: "choice",
    choices: ["queue", "steer"],
  },
  favorite: {
    usage: "favorite [on|off]",
    arguments: "choice",
    choices: ["on", "off"],
  },
}
export const commandDescriptors = Object.fromEntries(
  commandNames.map((name) => [
    name,
    {
      description: commandDescriptions[name],
      usage: name,
      arguments: "none",
      ...argumentDescriptors[name],
    },
  ]),
) as Readonly<Record<CommandName, CommandDescriptor>>

export interface CommandCompletionOptions {
  readonly sessionIds?: readonly string[]
  readonly models?: readonly string[]
  readonly modelEfforts?: Readonly<Record<string, readonly string[]>>
  readonly currentModel?: string
}
export function commandArgumentChoices(
  name: CommandName,
  options: CommandCompletionOptions = {},
): readonly string[] | undefined {
  if (name === "sessions") return options.sessionIds
  if (name === "model") return options.models
  if (name === "thinking")
    return options.currentModel
      ? options.modelEfforts?.[options.currentModel]
      : undefined
  return commandDescriptors[name].choices
}

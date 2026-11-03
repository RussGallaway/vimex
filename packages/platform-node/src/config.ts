import { parseCommand, themeNames, type ThemeName } from "@vimex/interaction"
import { homedir } from "node:os"
import { join } from "node:path"
import { JsonStore } from "./persistence/json-store"

export interface MachineConfig {
  sshHost: string
  label?: string
  cwd?: string
  codexExecutable?: string
}

export interface VimexConfig {
  version: 1
  theme: ThemeName
  syntaxTheme: "theme" | ThemeName
  reducedColor: boolean
  insertEnter: "newline" | "submit"
  busySubmit: "queue" | "steer"
  foldTools: boolean
  /** @deprecated Accepted as a v1 compatibility no-op; reasoning is not part of the primary transcript. */
  foldReasoning: boolean
  composerMaxHeight: number
  keybindings: Record<string, string>
  codexExecutable: string
  localTransport: "auto" | "daemon" | "stdio"
  caffeinate: boolean
  favoriteMachines: string[]
  machines: Record<string, MachineConfig>
}
export const defaultConfig: VimexConfig = {
  version: 1,
  theme: "ember-tide",
  syntaxTheme: "theme",
  reducedColor: false,
  insertEnter: "submit",
  busySubmit: "steer",
  foldTools: true,
  foldReasoning: true,
  composerMaxHeight: 0.33,
  keybindings: {},
  codexExecutable: "codex",
  localTransport: "auto",
  machines: {},
  favoriteMachines: [],
  caffeinate: true,
}
export function parseConfig(value: unknown): VimexConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration must be an object")
  const raw = value as Record<string, unknown>
  const allowed = new Set(Object.keys(defaultConfig))
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Error(`Unknown configuration key: ${key}`)
  const result = { ...defaultConfig, ...raw } as VimexConfig
  if (result.version !== 1) throw new Error("Unsupported configuration version")
  if (!themeNames.includes(result.theme)) throw new Error("Unknown theme")
  if (!["theme", ...themeNames].includes(result.syntaxTheme))
    throw new Error("Unknown syntax theme")
  if (typeof result.caffeinate !== "boolean")
    throw new Error("caffeinate must be a boolean")
  if (typeof result.reducedColor !== "boolean")
    throw new Error("reducedColor must be a boolean")
  if (!["newline", "submit"].includes(result.insertEnter))
    throw new Error("insertEnter must be newline or submit")
  if (!["queue", "steer"].includes(result.busySubmit))
    throw new Error("busySubmit must be queue or steer")
  if (
    typeof result.foldTools !== "boolean" ||
    typeof result.foldReasoning !== "boolean"
  )
    throw new Error("Fold settings must be booleans")
  if (
    typeof result.composerMaxHeight !== "number" ||
    !Number.isFinite(result.composerMaxHeight) ||
    result.composerMaxHeight < 0.1 ||
    result.composerMaxHeight > 0.6
  )
    throw new Error("composerMaxHeight must be between 0.1 and 0.6")
  if (
    !result.keybindings ||
    typeof result.keybindings !== "object" ||
    Array.isArray(result.keybindings) ||
    Object.values(result.keybindings).some((v) => typeof v !== "string")
  )
    throw new Error("keybindings must map keys to command names")
  if (
    Object.values(result.keybindings).some(
      (value) => parseCommand(value).kind !== "command",
    )
  )
    throw new Error("Keybindings must name a known command")
  if (
    typeof result.codexExecutable !== "string" ||
    !result.codexExecutable.trim()
  )
    throw new Error("codexExecutable must be a nonempty executable path")
  if (!["auto", "daemon", "stdio"].includes(result.localTransport))
    throw new Error("localTransport must be auto, daemon, or stdio")
  if (
    !result.machines ||
    typeof result.machines !== "object" ||
    Array.isArray(result.machines)
  )
    throw new Error("machines must map machine names to SSH settings")
  for (const [id, machine] of Object.entries(result.machines)) {
    if (id === "local" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
      throw new Error(`Invalid machine name: ${id}`)
    if (!machine || typeof machine !== "object" || Array.isArray(machine))
      throw new Error(`Invalid settings for machine ${id}`)
    for (const key of Object.keys(machine))
      if (!["sshHost", "cwd", "codexExecutable", "label"].includes(key))
        throw new Error(`Unknown machine setting: ${key}`)
    if (
      typeof machine.sshHost !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(machine.sshHost)
    )
      throw new Error(`Invalid SSH host for machine ${id}`)
    if (
      machine.label !== undefined &&
      (typeof machine.label !== "string" ||
        !machine.label.trim() ||
        machine.label.length > 80 ||
        /[\x00-\x1f\x7f-\x9f]/.test(machine.label))
    )
      throw new Error(`Invalid label for machine ${id}`)
    for (const key of ["cwd", "codexExecutable"] as const)
      if (
        machine[key] !== undefined &&
        (typeof machine[key] !== "string" ||
          !machine[key]!.trim() ||
          /[\x00-\x1f]/.test(machine[key]!))
      )
        throw new Error(`Invalid ${key} for machine ${id}`)
  }
  if (
    !Array.isArray(result.favoriteMachines) ||
    result.favoriteMachines.some(
      (id) =>
        typeof id !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
        (id !== "local" && !Object.hasOwn(result.machines, id)),
    ) ||
    new Set(result.favoriteMachines).size !== result.favoriteMachines.length
  )
    throw new Error(
      "favoriteMachines must contain unique configured machine names or local",
    )
  return result
}
export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vimex")
}
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "vimex")
}
export async function loadConfig(
  path = join(configDirectory(), "config.json"),
): Promise<VimexConfig> {
  return new JsonStore(path, parseConfig).read(defaultConfig)
}

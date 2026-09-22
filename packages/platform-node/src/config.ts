import { parseCommand, themeNames, type ThemeName } from "@vimex/interaction"
import { homedir } from "node:os"
import { join } from "node:path"
import { JsonStore } from "./persistence/json-store"

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
}
export const defaultConfig: VimexConfig = {
  version: 1,
  theme: "ember-tide",
  syntaxTheme: "theme",
  reducedColor: false,
  insertEnter: "submit",
  busySubmit: "queue",
  foldTools: true,
  foldReasoning: true,
  composerMaxHeight: 0.33,
  keybindings: {},
  codexExecutable: "codex",
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

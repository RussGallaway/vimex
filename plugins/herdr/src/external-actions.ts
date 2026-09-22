import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface HerdrExternalActionConfig {
  openUrl?: { command: readonly string[] }
}

export interface HerdrExternalActions {
  openUrl(url: string): Promise<void>
}

export interface HerdrExternalActionOptions {
  /** Herdr-owned plugin config directory. Defaults to the pane/action environment. */
  configDir?: string
  fallbackOpenUrl?: (url: string) => Promise<void>
  run?: (command: string, args: readonly string[]) => Promise<void>
}

/**
 * Creates the external-action port used by Vimex and the Herdr link handler.
 * `external-actions.json` may provide an argv command containing `{url}`. When
 * absent, URLs use the supplied fallback or the host platform opener.
 */
export function createHerdrExternalActions(
  options: HerdrExternalActionOptions = {},
): HerdrExternalActions {
  const configDir = options.configDir ?? process.env.HERDR_PLUGIN_CONFIG_DIR
  const fallback = options.fallbackOpenUrl ?? openPlatformUrl
  const run = options.run ?? runCommand
  return {
    async openUrl(target: string) {
      const url = webUrl(target)
      const config = configDir
        ? await readExternalActionConfig(configDir)
        : undefined
      const command = config?.openUrl?.command
      if (!command) return fallback(url)
      const argv = command.map((value) => value.replaceAll("{url}", url))
      if (!command.some((value) => value.includes("{url}"))) argv.push(url)
      await run(argv[0]!, argv.slice(1))
    },
  }
}

export async function readExternalActionConfig(
  configDir: string,
): Promise<HerdrExternalActionConfig | undefined> {
  let source: string
  try {
    source = await readFile(join(configDir, "external-actions.json"), "utf8")
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const value: unknown = JSON.parse(source)
  if (!isRecord(value))
    throw new Error("Herdr external-actions.json must contain an object")
  const unknown = Object.keys(value).filter((key) => key !== "openUrl")
  if (unknown.length)
    throw new Error(`Unknown Herdr external action setting: ${unknown[0]}`)
  if (value.openUrl === undefined) return {}
  if (
    !isRecord(value.openUrl) ||
    !Array.isArray(value.openUrl.command) ||
    value.openUrl.command.length === 0 ||
    !value.openUrl.command.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    throw new Error(
      "Herdr external action openUrl.command must be a non-empty argv string array",
    )
  }
  return { openUrl: { command: value.openUrl.command as string[] } }
}

export async function openPlatformUrl(
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const url = webUrl(target)
  if (platform === "darwin") return runCommand("open", [url])
  if (platform === "win32")
    return runCommand("rundll32.exe", ["url.dll,FileProtocolHandler", url])
  return runCommand("xdg-open", [url])
}

function webUrl(target: string): string {
  const url = new URL(target)
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  return url.href
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`External URL action exited ${String(code)}`)),
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

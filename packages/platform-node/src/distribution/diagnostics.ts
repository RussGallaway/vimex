import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import type { DiagnosticCheck, Installation } from "@vimex/distribution"
import { configDirectory, loadConfig } from "../config"
import { runProcess, type RunProcess } from "./homebrew"
export interface DiagnosticOptions { version: string; config?: string; cwd?: string; installation(): Promise<Installation>; run?: RunProcess }
export async function diagnoseNode(options: DiagnosticOptions): Promise<readonly DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [{ name: "Vimex", status: "ok", detail: `${options.version} (${process.platform}/${process.arch})` }]
  try { const install = await options.installation(); checks.push({ name: "Installation", status: install.kind === "unknown" ? "warning" : "ok", detail: install.kind }) }
  catch (error) { checks.push({ name: "Installation", status: "warning", detail: String(error) }) }
  const path = options.config ?? join(configDirectory(), "config.json")
  let codex = "codex"
  try { const config = await loadConfig(path); codex = config.codexExecutable; checks.push({ name: "Configuration", status: "ok", detail: path }) }
  catch (error) { checks.push({ name: "Configuration", status: "error", detail: String(error) }) }
  const run = options.run ?? runProcess
  await Promise.all(["Codex", "Git"].map(async name => {
    try {
      const result = await run(name === "Codex" ? codex : "git", ["--version"], { timeoutMs: 5000 })
      checks.push({ name, status: result.code === 0 ? "ok" : name === "Codex" ? "error" : "warning", detail: (result.stdout.trim() || result.stderr.trim() || `Exit ${result.code}`).slice(0, 500) })
    } catch (error) { checks.push({ name, status: name === "Codex" ? "error" : "warning", detail: String(error) }) }
  }))
  try { await access(options.cwd ?? process.cwd(), constants.R_OK | constants.X_OK); checks.push({ name: "Working directory", status: "ok", detail: options.cwd ?? process.cwd() }) }
  catch (error) { checks.push({ name: "Working directory", status: "error", detail: String(error) }) }
  checks.push({ name: "Terminal", status: process.stdout.isTTY ? "ok" : "warning", detail: process.stdout.isTTY ? process.env.TERM ?? "TTY" : "Non-interactive output; TUI requires a terminal" })
  return checks
}

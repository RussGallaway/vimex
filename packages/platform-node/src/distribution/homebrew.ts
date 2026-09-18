import { spawn } from "node:child_process"
export interface CommandResult { code: number; stdout: string; stderr: string }
export type RunProcess = (command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>
export const runProcess: RunProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    child.kill("SIGTERM")
    killTimer = setTimeout(() => { child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy() }, 250)
    reject(new Error(`${command} timed out`))
  }, options.timeoutMs ?? 30_000)
  child.stdout.on("data", chunk => { stdout += String(chunk) })
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  child.once("error", error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error) })
  child.once("close", code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolve({ code: code ?? 1, stdout, stderr }) })
})
export async function homebrewUpgrade(run: RunProcess = runProcess): Promise<void> {
  const result = await run("brew", ["upgrade", "russgallaway/vimex/vimex"], { timeoutMs: 15 * 60_000 })
  if (result.code !== 0) throw new Error(`Homebrew upgrade failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

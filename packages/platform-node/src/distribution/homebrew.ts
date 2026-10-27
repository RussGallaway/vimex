import { spawn } from "node:child_process"
export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}
export type RunProcess = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>
export const runProcess: RunProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    let timedOut = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child.kill("SIGKILL")
        child.stdout.destroy()
        child.stderr.destroy()
      }, 250)
      // A timeout is not complete until the child has been reaped. Keep a
      // final bound for an OS process that cannot be killed or reaped.
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        reject(new Error(`${command} timed out; process cleanup unconfirmed`))
      }, 5000)
    }, options.timeoutMs ?? 30_000)
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", (error) => {
      // A failed signal must not cancel escalation or the cleanup deadline.
      if (timedOut) return
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      if (timedOut) reject(new Error(`${command} timed out`))
      else resolve({ code: code ?? 1, stdout, stderr })
    })
  })
export async function homebrewUpgrade(
  run: RunProcess = runProcess,
): Promise<void> {
  const result = await run("brew", ["upgrade", "russgallaway/vimex/vimex"], {
    timeoutMs: 15 * 60_000,
  })
  if (result.code !== 0)
    throw new Error(
      `Homebrew upgrade failed: ${result.stderr.trim() || result.stdout.trim()}`,
    )
}

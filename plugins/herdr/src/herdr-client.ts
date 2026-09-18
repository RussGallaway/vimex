import { spawn } from "node:child_process"

export interface HerdrContext { paneId: string; binPath?: string }
export type HerdrRunner = (args: readonly string[]) => Promise<void>

export function detectHerdr(env: NodeJS.ProcessEnv = process.env): HerdrContext | undefined {
  return env.HERDR_ENV === "1" && env.HERDR_PANE_ID
    ? { paneId: env.HERDR_PANE_ID, ...(env.HERDR_BIN_PATH ? { binPath: env.HERDR_BIN_PATH } : {}) }
    : undefined
}

interface HerdrChildProcess {
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown }
  once(event: "error", listener: (error: Error) => void): unknown
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type HerdrSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "ignore", "pipe"]; shell: false },
) => HerdrChildProcess

export interface HerdrRunnerOptions {
  executable?: string
  timeoutMs?: number
  killGraceMs?: number
  spawnProcess?: HerdrSpawn
}

/** Run a bounded Herdr CLI request and terminate a stuck child process. */
export function createHerdrRunner(options: HerdrRunnerOptions = {}): HerdrRunner {
  const executable = options.executable ?? process.env.HERDR_BIN_PATH ?? "herdr"
  const timeoutMs = options.timeoutMs ?? 3_000
  const killGraceMs = options.killGraceMs ?? 250
  const spawnProcess: HerdrSpawn = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions))

  return args => new Promise((resolve, reject) => {
    let child: HerdrChildProcess
    try {
      child = spawnProcess(executable, args, { stdio: ["ignore", "ignore", "pipe"], shell: false })
    } catch (error) {
      reject(asError(error))
      return
    }

    let errors = ""
    let settled = false
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      error ? reject(error) : resolve()
    }
    const timeoutError = () => new Error(`Herdr request timed out after ${timeoutMs}ms`)

    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096) })
    child.once("error", error => finish(error))
    child.once("exit", (code, signal) => {
      if (timedOut) return finish(timeoutError())
      code === 0
        ? finish()
        : finish(new Error(errors || `Herdr exited ${String(code)}${signal ? ` (${signal})` : ""}`))
    })

    if (timeoutMs > 0) timeout = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGTERM") } catch (error) { return finish(asError(error)) }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL") } catch (error) { return finish(asError(error)) }
        finish(timeoutError())
      }, killGraceMs)
    }, timeoutMs)
  })
}

export const runHerdr: HerdrRunner = createHerdrRunner()

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }

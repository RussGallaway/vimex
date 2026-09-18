import { resolve } from "node:path"

export interface CliOptions {
  cwd: string
  thread?: string
  model?: string
  config?: string
  demo: boolean
  help: boolean
  version: boolean
}
export function parseCliOptions(args: readonly string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = { cwd, demo: false, help: false, version: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--version" || arg === "-V") options.version = true
    else if (arg === "--demo") options.demo = true
    else if (["--cwd", "--thread", "--model", "--config"].includes(arg ?? "")) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      if (arg === "--cwd") options.cwd = resolve(cwd, value)
      else if (arg === "--thread") options.thread = value
      else if (arg === "--model") options.model = value
      else options.config = resolve(cwd, value)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}
export const helpText = `Vimex — Codex, operated like Vim

Usage: vimex [options]

  --cwd PATH       Working directory (defaults to current directory)
  --thread ID      Resume a Codex thread
  --model NAME     Model for a new thread
  --config PATH    Read an alternate Vimex JSON configuration
  --demo           Run a local streaming demonstration without Codex
  -h, --help       Show help
  -V, --version    Show version

Normal: i compose · Ctrl-w k/j focus · Ctrl-u/d scroll · v select · :help commands
Insert: Enter send · Shift+Enter newline · Esc Normal
`

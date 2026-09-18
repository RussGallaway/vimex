import { parseCliOptions, type CliOptions } from "../../tui/src/cli-options"
export type CliCommand = { kind: "launch"; options: CliOptions } | { kind: "help" | "version" } | { kind: "doctor"; config?: string } | { kind: "upgrade"; version?: string }

/** Parse syntax without loading OpenTUI, contacting Codex, or changing the cwd. */
export function parseCommand(args: readonly string[], cwd = process.cwd()): CliCommand {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") return { kind: "help" }
  const [head, ...tail] = args
  if (head === "upgrade" || head === "update") {
    if (!tail.length) return { kind: "upgrade" }
    if (tail.length === 2 && tail[0] === "--version" && /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tail[1]!)) return { kind: "upgrade", version: tail[1] }
    throw new Error("Usage: vimex upgrade [--version VERSION]")
  }
  if (head === "doctor") {
    if (!tail.length) return { kind: "doctor" }
    if (tail.length === 2 && tail[0] === "--config" && tail[1] && !tail[1].startsWith("-")) return { kind: "doctor", config: parseCliOptions(tail, cwd).config }
    throw new Error("Usage: vimex doctor [--config PATH]")
  }
  const resume = head === "resume"
  const values = resume ? tail : [...args]
  let positional: string | undefined
  let last = false
  const flags: string[] = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (value === "--last") { if (!resume || last) throw new Error("--last is only valid once with resume"); last = true; continue }
    if (value === "--") {
      if (positional || values.length !== i + 2) throw new Error("Expected one path or session ID after --")
      positional = values[++i]; continue
    }
    if (!value.startsWith("-")) {
      if (positional) throw new Error("Only one path or session ID is accepted")
      positional = value; continue
    }
    flags.push(value)
    if (["--cwd", "--thread", "--model", "--config"].includes(value)) {
      const next = values[++i]
      if (!next || next.startsWith("-")) throw new Error(`${value} requires a value`)
      flags.push(next)
    }
  }
  const options = parseCliOptions(flags, cwd)
  if (options.version) return { kind: "version" }
  if (resume) {
    if ((last && (positional || options.thread)) || (positional && options.thread)) throw new Error("Choose a session ID or --last, not both")
    if (options.demo) throw new Error("resume cannot be combined with --demo")
    if (positional) options.thread = positional
    if (!options.thread) options.resumeMode = last ? "last" : "picker"
  } else if (positional) {
    if (flags.includes("--cwd")) throw new Error("Choose a path or --cwd, not both")
    options.cwd = parseCliOptions(["--cwd", positional], cwd).cwd
  }
  return { kind: "launch", options }
}

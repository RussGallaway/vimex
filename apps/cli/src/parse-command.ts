import { parseCliOptions, type CliOptions } from "../../tui/src/cli-options"
export type RexCommand =
  | { action: "resume-pane" | "import-state" }
  | { action: "hook" | "install" | "uninstall"; shell: "zsh" | "bash" }
export type CliCommand =
  | { kind: "launch"; options: CliOptions }
  | { kind: "help" | "version" }
  | { kind: "doctor"; config?: string }
  | { kind: "upgrade"; version?: string }
  | { kind: "rex"; command: RexCommand }

/** Parse syntax without loading OpenTUI, contacting Codex, or changing the cwd. */
export function parseCommand(
  args: readonly string[],
  cwd = process.cwd(),
): CliCommand {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help")
    return { kind: "help" }
  const [head, ...tail] = args
  if (head === "rex") {
    const [action, ...values] = tail
    if (
      (action === "resume-pane" || action === "import-state") &&
      !values.length
    )
      return { kind: "rex", command: { action } }
    if (
      action === "hook" &&
      values.length === 1 &&
      (values[0] === "zsh" || values[0] === "bash")
    )
      return { kind: "rex", command: { action, shell: values[0] } }
    if (
      (action === "install" || action === "uninstall") &&
      values.length === 2 &&
      values[0] === "--shell" &&
      (values[1] === "zsh" || values[1] === "bash")
    )
      return { kind: "rex", command: { action, shell: values[1] } }
    throw new Error(
      "Usage: vimex rex hook zsh|bash | vimex rex install|uninstall --shell zsh|bash | vimex rex resume-pane|import-state",
    )
  }
  if (head === "upgrade" || head === "update") {
    if (!tail.length) return { kind: "upgrade" }
    if (
      tail.length === 2 &&
      tail[0] === "--version" &&
      /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tail[1]!)
    )
      return { kind: "upgrade", version: tail[1] }
    throw new Error("Usage: vimex upgrade [--version VERSION]")
  }
  if (head === "doctor") {
    if (!tail.length) return { kind: "doctor" }
    if (
      tail.length === 2 &&
      tail[0] === "--config" &&
      tail[1] &&
      !tail[1].startsWith("-")
    )
      return { kind: "doctor", config: parseCliOptions(tail, cwd).config }
    throw new Error("Usage: vimex doctor [--config PATH]")
  }
  const resume = head === "resume"
  const values = resume ? tail : [...args]
  let positional: string | undefined
  let last = false
  const flags: string[] = []
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (value === "--last") {
      if (!resume || last)
        throw new Error("--last is only valid once with resume")
      last = true
      continue
    }
    if (value === "--") {
      if (positional || values.length !== i + 2)
        throw new Error("Expected one path or session ID after --")
      positional = values[++i]
      continue
    }
    if (!value.startsWith("-")) {
      if (positional) throw new Error("Only one path or session ID is accepted")
      positional = value
      continue
    }
    flags.push(value)
    if (
      ["--cwd", "--thread", "--model", "--config", "--machine"].includes(value)
    ) {
      const next = values[++i]
      if (!next || next.startsWith("-"))
        throw new Error(`${value} requires a value`)
      flags.push(next)
    }
  }
  const options = parseCliOptions(flags, cwd)
  if (options.version) return { kind: "version" }
  if (resume) {
    if (
      (last && (positional || options.thread)) ||
      (positional && options.thread)
    )
      throw new Error("Choose a session ID or --last, not both")
    if (options.demo) throw new Error("resume cannot be combined with --demo")
    if (positional) options.thread = positional
    if (!options.thread) options.resumeMode = last ? "last" : "picker"
  } else if (positional) {
    if (flags.includes("--cwd"))
      throw new Error("Choose a path or --cwd, not both")
    options.cwd = parseCliOptions(["--cwd", positional], cwd).cwd
    if (options.machine && options.machine !== "local")
      options.remoteCwd = positional
  }
  return { kind: "launch", options }
}

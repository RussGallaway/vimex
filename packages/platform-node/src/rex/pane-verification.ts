import type { PaneIdentity } from "../persistence/pane-state"

export type RexIdentityProbe = (identity: PaneIdentity) => Promise<unknown>
export type RexTerminalProbe = (
  identity: PaneIdentity,
) => Promise<{ input: string; pane: string }>

async function rexJson(
  identity: PaneIdentity,
  args: readonly string[],
): Promise<unknown> {
  const child = Bun.spawn(
    ["rex", "--autostart=false", "--server", identity.server, ...args],
    {
      env: {
        ...process.env,
        REX_SERVER: identity.server,
        REX_SESSION: identity.session,
        REX_BLOCK: identity.block,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(
      `Unable to verify Rex pane: ${stderr.trim() || `rex exited ${code}`}`,
    )
  return JSON.parse(stdout)
}

function probe(identity: PaneIdentity): Promise<unknown> {
  return rexJson(identity, ["whoami", "--json"])
}

async function processOutput(
  args: string[],
  inheritInput = false,
): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: inheritInput ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(
      `Unable to verify Rex terminal: ${error.trim() || args[0] + " exited " + code}`,
    )
  return output.trim()
}

async function terminal(
  identity: PaneIdentity,
): Promise<{ input: string; pane: string }> {
  const value = await rexJson(identity, [
    "block",
    "call",
    "-s",
    identity.session,
    "-b",
    identity.block,
    "process",
  ])
  const pid = (value as { child?: { pid?: unknown } } | undefined)?.child?.pid
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Rex pane has no live terminal process")
  const [input, pane] = await Promise.all([
    // Inspect fd 0, rather than our controlling terminal: fixtures may redirect
    // stdin to another PTY while retaining their parent's controlling terminal.
    processOutput(["tty"], true),
    processOutput(["ps", "-p", String(pid), "-o", "tty="]),
  ])
  return { input, pane }
}

function terminalName(value: string): string | undefined {
  const name = value.trim().replace(/^\/dev\//, "")
  return !name ||
    name === "?" ||
    name === "??" ||
    name === "-" ||
    name === "not a tty"
    ? undefined
    : name
}

function endpoint(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === "unix:")
      return `unix://${decodeURIComponent(url.pathname)}`
    return url.toString().replace(/\/$/, "")
  } catch {
    return value
  }
}

/** Never adopt a nonexistent inherited pane or Rex's fallback server. */
export async function verifyRexPane(
  identity: PaneIdentity,
  inspect: RexIdentityProbe = probe,
  inspectTerminal: RexTerminalProbe = terminal,
): Promise<void> {
  const value = await inspect(identity)
  if (!value || typeof value !== "object")
    throw new Error("Invalid Rex identity response")
  const result = value as Record<string, unknown>
  if (
    typeof result.endpoint !== "string" ||
    endpoint(result.endpoint) !== endpoint(identity.server) ||
    result.session_id !== identity.session ||
    result.block_id !== identity.block
  )
    throw new Error(
      "Rex pane identity does not match this terminal; restoration was skipped",
    )
  const terminals = await inspectTerminal(identity)
  const input = terminalName(terminals.input)
  const pane = terminalName(terminals.pane)
  if (!input || !pane || input !== pane)
    throw new Error(
      "Rex pane does not own this input terminal; restoration was skipped",
    )
}

import { ProxyWebSocketTransport } from "./proxy-websocket-transport"
import {
  CodexAppServerClient,
  createCodexAppServerClient,
} from "../capabilities/codex-app-server-client"
import type { StdioTransportOptions } from "./stdio-transport"

export interface CodexMachine {
  id: string
  sshHost?: string
  executable?: string
  mode?: "daemon" | "stdio"
}

/** POSIX shell quoting is required even with spawn's argv: SSH sends a shell command. */
export function quoteShell(value: string): string {
  if (value.includes("\0"))
    throw new Error("Shell arguments cannot contain NUL")
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function machineStdioOptions(
  cwd: string,
  machine: CodexMachine,
): StdioTransportOptions {
  const executable = machine.executable ?? "codex"
  if (machine.mode === "stdio" && !machine.sshHost)
    return { cwd, command: executable }
  if (
    machine.sshHost &&
    (!machine.sshHost.trim() ||
      /^[\s-]/u.test(machine.sshHost) ||
      /[\r\n\0]/u.test(machine.sshHost))
  )
    throw new Error("Invalid SSH host alias")
  // Resolve on every connection so upgrades can replace the managed `current`
  // symlink without persisting a versioned executable in Vimex configuration.
  const resolveExecutable =
    executable === "codex"
      ? `vimex_codex=$(command -v codex 2>/dev/null || true)
if [ -z "$vimex_codex" ]; then
  for vimex_candidate in "$HOME/.local/bin/codex" "$HOME/.codex/packages/app-server-daemon/current/bin/codex"; do
    if [ -x "$vimex_candidate" ]; then vimex_codex=$vimex_candidate; break; fi
  done
fi
[ -n "$vimex_codex" ] || { echo 'Codex executable not found on selected machine' >&2; exit 127; }`
      : `vimex_codex=${quoteShell(executable)}`
  const script = `${resolveExecutable}
${
  machine.mode === "stdio"
    ? `cd ${quoteShell(cwd)} || exit
exec "$vimex_codex" app-server --listen stdio://`
    : `"$vimex_codex" app-server daemon start >&2 || { echo 'Unable to start the Codex daemon. Run codex app-server daemon bootstrap on this machine, then retry (or set localTransport to stdio for local work).' >&2; exit 1; }
exec "$vimex_codex" app-server proxy`
}`
  return machine.sshHost
    ? {
        command: "ssh",
        args: [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          "--",
          machine.sshHost,
          `sh -lc ${quoteShell(script)}`,
        ],
      }
    : { command: "sh", args: ["-lc", script], cwd }
}

export function createMachineCodexClient(cwd: string, machine: CodexMachine) {
  const options = machineStdioOptions(cwd, machine)
  if (machine.mode === "stdio")
    return createCodexAppServerClient(options, { experimentalApi: true })
  return new CodexAppServerClient(
    new ProxyWebSocketTransport({
      command: options.command!,
      args: options.args,
      cwd: options.cwd,
    }),
    { experimentalApi: true },
  )
}

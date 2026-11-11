import { resolve } from "node:path"
import {
  configureRexShellHook,
  createRexShellHook,
  paneIdentity,
  PaneStateStore,
  verifyRexPane,
} from "@vimex/platform-node"
import type { CliOptions } from "../../tui/src/cli-options"
import type { RexCommand } from "./parse-command"
import { rexLauncher } from "./rex-launcher"

declare const VIMEX_COMPILED: boolean

function launcher(): Promise<string[]> {
  return rexLauncher({
    compiled: typeof VIMEX_COMPILED !== "undefined" && VIMEX_COMPILED,
    executable: process.execPath,
    entry: resolve(import.meta.dir, "main.ts"),
    invoked: process.argv[0],
    path: process.env.PATH,
  })
}

/** Headless commands never import the renderer; only a matching active pane launches it. */
export async function runRexCommand(
  command: RexCommand,
  options: {
    write(text: string): void
    environment?: NodeJS.ProcessEnv
    terminal?: boolean
    stateRoot?: string
    launcher?: readonly string[]
    verify?: typeof verifyRexPane
    home?: string
  },
): Promise<CliOptions | undefined> {
  const executable = options.launcher ?? (await launcher())
  if (command.action === "hook") {
    options.write(createRexShellHook(command.shell, executable))
    return
  }
  if (command.action === "install" || command.action === "uninstall") {
    const paths = await configureRexShellHook({
      shell: command.shell,
      command: executable,
      remove: command.action === "uninstall",
      home: options.home,
    })
    options.write(
      `${command.action === "install" ? "Enabled" : "Removed"} Vimex Rex restoration in ${paths.join(", ")}.${command.action === "install" ? " New interactive Rex shells will check their saved pane automatically." : ""}`,
    )
    return
  }
  if (!(
    options.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  )) {
    if (command.action === "import-state")
      throw new Error(
        "Legacy state import requires an interactive Rex terminal",
      )
    return
  }
  const identity = paneIdentity(options.environment)
  if (!identity) {
    if (command.action === "import-state")
      throw new Error(
        "Legacy state import requires a complete Rex pane identity",
      )
    return
  }
  if (command.action === "import-state") {
    await (options.verify ?? verifyRexPane)(identity)
    const { importPaneState } = await import("@vimex/platform-node")
    const result = await importPaneState(identity, options.stateRoot)
    options.write(
      `Imported ${result.threads} saved views and ${result.images} images for ${result.machine}. Legacy files were preserved.`,
    )
    return
  }
  const checkpoint = await new PaneStateStore(
    identity,
    options.stateRoot,
  ).read()
  if (!checkpoint?.active) return
  await (options.verify ?? verifyRexPane)(identity)
  const target = checkpoint.target
  const remote = target.machine !== "local"
  return {
    cwd: remote ? target.localCwd : target.cwd,
    machine: target.machine,
    ...(remote ? { remoteCwd: target.cwd } : {}),
    ...(target.thread ? { thread: target.thread } : {}),
    ...(target.config ? { config: target.config } : {}),
    ...(target.model ? { model: target.model } : {}),
    restorePane: true,
    demo: false,
    help: false,
    version: false,
  }
}

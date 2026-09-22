import type { CliOptions } from "../../tui/src/cli-options"
import type { CliCommand } from "./parse-command"
import { helpText } from "./help"
export interface CommandPorts {
  version: string
  write(text: string): void
  launch(options: CliOptions): Promise<void>
  doctor(config?: string): Promise<void | number>
  upgrade(version?: string): Promise<void | number>
}
export async function runCommand(
  command: CliCommand,
  ports: CommandPorts,
): Promise<number> {
  switch (command.kind) {
    case "help":
      ports.write(helpText)
      return 0
    case "version":
      ports.write(`vimex ${ports.version}`)
      return 0
    case "doctor":
      return (await ports.doctor(command.config)) ?? 0
    case "upgrade":
      return (await ports.upgrade(command.version)) ?? 0
    case "launch":
      await ports.launch(command.options)
      return 0
  }
}

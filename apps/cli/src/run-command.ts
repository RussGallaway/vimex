import type { CliOptions } from "../../tui/src/cli-options"
import type { CliCommand, RexCommand } from "./parse-command"
import { helpText } from "./help"
export interface CommandPorts {
  version: string
  write(text: string): void
  launch(options: CliOptions): Promise<void>
  doctor(config?: string): Promise<void | number>
  upgrade(version?: string): Promise<void | number>
  rex(command: RexCommand): Promise<CliOptions | undefined>
}
export async function runCommand(
  command: CliCommand,
  ports: CommandPorts,
): Promise<number> {
  switch (command.kind) {
    case "rex": {
      const options = await ports.rex(command.command)
      if (options) await ports.launch(options)
      return 0
    }
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

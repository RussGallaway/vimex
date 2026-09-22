import { version } from "../../../package.json"
import type { CommandPorts } from "./run-command"
import { configurePackagedAssets } from "./runtime-assets"
export function createCommandPorts(): CommandPorts {
  return {
    version,
    write: (text) => console.log(text),
    launch: async (options) => {
      configurePackagedAssets()
      const { resolveLaunchDirectory } = await import("./launch-directory")
      const cwd = await resolveLaunchDirectory(options.cwd)
      const { runApplication } = await import("../../tui/src/composition-root")
      await runApplication({ ...options, cwd })
    },
    doctor: async (config) => {
      const { createDistributionCommands } =
        await import("@vimex/platform-node")
      const report = await createDistributionCommands({
        version,
        config,
      }).doctor()
      for (const check of report.checks)
        console.log(
          `${check.status.toUpperCase()} ${check.name}: ${check.detail}`,
        )
      return report.healthy ? 0 : 1
    },
    upgrade: async (target) => {
      const { createDistributionCommands } =
        await import("@vimex/platform-node")
      console.log(
        (await createDistributionCommands({ version }).upgrade(target)).message,
      )
    },
  }
}

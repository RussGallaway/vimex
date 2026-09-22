import { diagnose, upgrade, type DistributionPorts } from "@vimex/distribution"
import { GithubReleases } from "./github-releases"
import { detectInstallation } from "./installation-receipt"
import { homebrewUpgrade } from "./homebrew"
import { installDirect } from "./direct-installer"
import { diagnoseNode } from "./diagnostics"
export interface DistributionCommandOptions {
  version: string
  executablePath?: string
  source?: boolean
  config?: string
  cwd?: string
}
export function createDistributionCommands(
  options: DistributionCommandOptions,
) {
  const releases = new GithubReleases()
  const installation = () =>
    detectInstallation(
      options.executablePath ?? process.execPath,
      options.source,
    )
  const ports: DistributionPorts = {
    currentVersion: options.version,
    platform: process.platform,
    arch: process.arch,
    installation,
    releases,
    install: (release, artifact, root) =>
      installDirect(release, artifact, root, {
        download: (version, name) => releases.download(version, name),
      }),
    homebrewUpgrade,
    diagnostics: () => diagnoseNode({ ...options, installation }),
  }
  return {
    doctor: () => diagnose(ports),
    upgrade: (version?: string) => upgrade(ports, version),
  }
}

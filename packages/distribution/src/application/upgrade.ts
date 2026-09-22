import { planUpgrade } from "../domain/upgrade-plan"
import { compareVersions, releaseArtifact } from "../domain/release"
import type { DistributionPorts } from "./distribution-ports"
export interface UpgradeResult {
  status: "updated" | "current" | "instructions"
  message: string
}
export async function upgrade(
  ports: DistributionPorts,
  version?: string,
): Promise<UpgradeResult> {
  const plan = planUpgrade(await ports.installation(), version)
  if (plan.kind === "instructions")
    return { status: "instructions", message: plan.message }
  if (plan.kind === "homebrew") {
    await ports.homebrewUpgrade()
    return { status: "updated", message: "Homebrew upgrade completed." }
  }
  const release = await ports.releases.get(plan.version)
  const precedence = compareVersions(release.version, ports.currentVersion)
  if (precedence === 0)
    return {
      status: "current",
      message: `Vimex ${release.version} is already installed.`,
    }
  if (!plan.version && precedence < 0)
    return {
      status: "current",
      message: `Vimex ${ports.currentVersion} is newer than the latest release ${release.version}; keeping the installed version.`,
    }
  const artifact = releaseArtifact(release, ports.platform, ports.arch)
  const installed = await ports.install(release, artifact, plan.root)
  return {
    status: "updated",
    message: `Installed Vimex ${release.version}. Restart Vimex to use the new version.${installed?.warning ? ` ${installed.warning}` : ""}`,
  }
}

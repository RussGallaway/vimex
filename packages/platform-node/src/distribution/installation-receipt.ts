import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { normalizeVersion, type Installation } from "@vimex/distribution"
export interface InstallationReceipt {
  schemaVersion: 1
  kind: "direct"
  version: string
}
export async function detectInstallation(
  executablePath: string,
  source = false,
): Promise<Installation> {
  if (
    source ||
    /\.[cm]?[jt]sx?$/.test(executablePath) ||
    /^bun(?:\.exe)?$/.test(basename(executablePath))
  )
    return { kind: "source" }
  const executable = await realpath(executablePath)
  if (/\/Cellar\/vimex\//.test(executable)) return { kind: "homebrew" }
  const root = dirname(dirname(dirname(executable)))
  if (
    basename(dirname(dirname(executable))) !== "versions" ||
    basename(executable) !== "vimex"
  )
    return { kind: "unknown" }
  try {
    const receipt = JSON.parse(
      await readFile(join(root, ".vimex-install.json"), "utf8"),
    ) as Partial<InstallationReceipt>
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "direct" ||
      typeof receipt.version !== "string"
    )
      return { kind: "unknown" }
    return {
      kind: "direct",
      root: resolve(root),
      executable,
      version: normalizeVersion(receipt.version),
    }
  } catch {
    return { kind: "unknown" }
  }
}

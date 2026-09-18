import type { Installation } from "./installation"
import { normalizeVersion } from "./release"
export type UpgradePlan = { kind: "instructions"; message: string } | { kind: "homebrew" } | { kind: "direct"; version?: string; root: string }
export function planUpgrade(installation: Installation, requestedVersion?: string): UpgradePlan {
  const version = requestedVersion === undefined ? undefined : normalizeVersion(requestedVersion)
  if (installation.kind === "unknown") return { kind: "instructions", message: "This executable has no recognized installation ownership. Reinstall using the official installer or Homebrew; Vimex will not overwrite it." }
  if (installation.kind === "source") return { kind: "instructions", message: "This is a source checkout. Update it with git pull --ff-only, then bun install. Vimex will not replace source files." }
  if (installation.kind === "homebrew") {
    if (version) return { kind: "instructions", message: "Homebrew owns this installation. Use brew upgrade russgallaway/vimex/vimex for the tap's current release; selecting an explicit version is not supported." }
    return { kind: "homebrew" }
  }
  return { kind: "direct", root: installation.root, version }
}

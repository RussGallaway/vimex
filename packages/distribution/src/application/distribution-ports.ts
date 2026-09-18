import type { Installation } from "../domain/installation"
import type { Release, ReleaseArtifact } from "../domain/release"
export interface DiagnosticCheck { name: string; status: "ok" | "warning" | "error"; detail: string }
export interface DistributionPorts {
  installation(): Promise<Installation>
  releases: { get(version?: string): Promise<Release> }
  install(release: Release, artifact: ReleaseArtifact, root: string): Promise<{ warning?: string } | void>
  homebrewUpgrade(): Promise<void>
  diagnostics(): Promise<readonly DiagnosticCheck[]>
  platform: string
  arch: string
  currentVersion: string
}

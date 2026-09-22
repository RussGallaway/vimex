import type { DiagnosticCheck, DistributionPorts } from "./distribution-ports"
export interface DiagnosticReport {
  checks: readonly DiagnosticCheck[]
  healthy: boolean
}
export async function diagnose(
  ports: Pick<DistributionPorts, "diagnostics">,
): Promise<DiagnosticReport> {
  const checks = await ports.diagnostics()
  return { checks, healthy: checks.every((check) => check.status !== "error") }
}

import type { CliRenderer } from "@opentui/core"

export const navigationMeasurementBudgetEnabled =
  process.env.VIMEX_NAV_BUDGET_MEASUREMENTS === "1"
export const navigationMeasurementDiagnosticsEnabled =
  navigationMeasurementBudgetEnabled ||
  process.env.VIMEX_NAV_MEASUREMENT_DIAGNOSTICS === "1"

/** Diagnostic scheduling budget, shared by all preparation passes in a frame. */
export class NavigationMeasurementBudget {
  readonly diagnostics = {
    motions: 0,
    requiredMeasurements: 0,
    backgroundMeasurements: 0,
    deferredAttempts: 0,
    measurementMs: 0,
    backgroundMeasurementMs: 0,
    pending: 0,
  }
  private deadline = 0
  private frameId: number | undefined
  private attempts = 0
  private spentMs = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  get active(): boolean {
    return this.now() < this.deadline
  }

  motion(): void {
    this.diagnostics.motions++
    this.deadline = this.now() + 120
  }

  allow(frameId: number, required: boolean): boolean {
    if (this.frameId !== frameId) {
      this.frameId = frameId
      this.attempts = 0
      this.spentMs = 0
    }
    if (required || !this.active) return true
    if (this.attempts >= 8 || this.spentMs >= 2) {
      this.diagnostics.deferredAttempts++
      return false
    }
    this.attempts++
    return true
  }

  record(required: boolean, durationMs: number): void {
    this.diagnostics.measurementMs += durationMs
    if (required) this.diagnostics.requiredMeasurements++
    else {
      this.diagnostics.backgroundMeasurements++
      this.diagnostics.backgroundMeasurementMs += durationMs
      this.spentMs += durationMs
    }
  }

  async whenIdle(): Promise<void> {
    while (this.active)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, this.deadline - this.now())),
      )
  }

  dispose(): void {
    this.deadline = 0
  }
}

const budgets = new WeakMap<CliRenderer, NavigationMeasurementBudget>()
export function navigationMeasurementBudget(
  renderer: CliRenderer,
): NavigationMeasurementBudget {
  let budget = budgets.get(renderer)
  if (!budget) {
    budget = new NavigationMeasurementBudget()
    budgets.set(renderer, budget)
  }
  return budget
}

import type { ThreadSummary } from "@vimex/conversation"
import { createHerdrRunner, runHerdr, type HerdrContext, type HerdrRunner } from "./herdr-client"
import { metadataCommand } from "./metadata-reporter"
import { lifecycleCommand, releaseCommand, sessionCommand, type HerdrLifecycleState } from "./session-reporter"

export type HerdrConnection = "connecting" | "connected" | "disconnected" | "error"
export interface HerdrReport {
  summary?: ThreadSummary
  connection?: HerdrConnection
  /** Number of unresolved approvals belonging to `summary.id`. */
  pendingApprovals?: number
}

interface ReportReadModel {
  summary?: ThreadSummary
  connection: HerdrConnection
  pendingApprovals: number
}
interface PendingReport { value: ReportReadModel; signature: string }

/** Reports the calling pane while retaining at most one latest queued state. */
export class HerdrReporter {
  private readonly run: HerdrRunner
  private drainPromise?: Promise<void>
  private pending?: PendingReport
  private activeSignature?: string
  private previousSignature?: string
  private sequence = 0
  private disposed = false

  constructor(private readonly context: HerdrContext | undefined, run?: HerdrRunner) {
    this.run = run ?? (context?.binPath ? createHerdrRunner({ executable: context.binPath }) : runHerdr)
  }

  report(report: HerdrReport): Promise<void> {
    if (!this.context || this.disposed) return Promise.resolve()
    const value: ReportReadModel = {
      summary: report.summary,
      connection: report.connection ?? "connected",
      pendingApprovals: Math.max(0, Math.floor(report.pendingApprovals ?? 0)),
    }
    const signature = reportSignature(value)
    if (signature === this.previousSignature && !this.activeSignature && !this.pending) return Promise.resolve()
    if (signature === this.pending?.signature && this.drainPromise) return this.drainPromise
    if (signature === this.activeSignature && !this.pending && this.drainPromise) return this.drainPromise
    this.pending = { value, signature }
    return this.ensureDrain()
  }

  async dispose(): Promise<void> {
    if (!this.context || this.disposed) return
    this.disposed = true
    await this.drainPromise?.catch(() => {})
    this.pending = undefined
    await this.run(releaseCommand(this.context.paneId, ++this.sequence))
  }

  private ensureDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    const operation = this.drain()
    const tracked = operation.finally(() => {
      if (this.drainPromise === tracked) this.drainPromise = undefined
    })
    this.drainPromise = tracked
    return tracked
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      const next = this.pending
      this.pending = undefined
      if (next.signature === this.previousSignature) continue
      this.activeSignature = next.signature
      try {
        await this.emit(next.value)
        this.previousSignature = next.signature
      } catch (error) {
        if (!this.pending) this.pending = next
        throw error
      } finally {
        this.activeSignature = undefined
      }
    }
  }

  private async emit(report: ReportReadModel): Promise<void> {
    if (!this.context) return
    const sequence = ++this.sequence
    const state = lifecycleState(report)
    const thread = report.summary?.id
    await this.run(lifecycleCommand(this.context.paneId, sequence, state, thread))
    if (thread) await this.run(sessionCommand(this.context.paneId, sequence, thread))
    await this.run(metadataCommand(this.context.paneId, sequence, report))
  }
}

function lifecycleState(report: ReportReadModel): HerdrLifecycleState {
  if (report.connection !== "connected") return "unknown"
  if (report.pendingApprovals > 0) return "blocked"
  if (!report.summary || report.summary.status === "disconnected") return "unknown"
  return report.summary.status
}

function reportSignature(report: ReportReadModel): string {
  const summary = report.summary
  return JSON.stringify([
    summary?.id, summary?.title, summary?.cwd, summary?.model, summary?.reasoningEffort,
    summary?.gitBranch, summary?.status,
    report.connection, report.pendingApprovals,
  ])
}

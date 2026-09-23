import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const defaultMaxAgeMs = 15 * 60 * 1000
const defaultMaxRecords = 4096
const hardMaxRecords = 16384

const phases = new Set<string>([
  "input",
  "attempted",
  "accepted",
  "state_updated",
  "state_published",
  "adapter_start",
  "request_sent",
  "first_server_activity",
  "next_thread_activity",
  "next_thread_content",
  "next_thread_content_committed",
  "next_frame_after_content_commit",
  "superseded",
  "first_activity",
  "first_content",
  "first_activity_painted",
  "first_content_painted",
  "first_activity_frame",
  "first_content_frame",
  "first_navigation_frame",
  "frame_painted",
  "destination_painted",
  "next_renderer_frame",
] as const)

export type PerformancePhase =
  | "input"
  | "attempted"
  | "accepted"
  | "state_updated"
  | "state_published"
  | "adapter_start"
  | "request_sent"
  | "first_server_activity"
  | "next_thread_activity"
  | "next_thread_content"
  | "next_thread_content_committed"
  | "next_frame_after_content_commit"
  | "superseded"
  | "first_activity"
  | "first_content"
  | "first_activity_painted"
  | "first_content_painted"
  | "first_activity_frame"
  | "first_content_frame"
  | "first_navigation_frame"
  | "frame_painted"
  | "destination_painted"
  | "next_renderer_frame"

export type PerformanceAction =
  | "line_up"
  | "line_down"
  | "half_page_up"
  | "half_page_down"
  | "page_up"
  | "page_down"
  | "wheel_up"
  | "wheel_down"
  | "top"
  | "bottom"
  | "other"

const actions = new Set<PerformanceAction>([
  "line_up",
  "line_down",
  "half_page_up",
  "half_page_down",
  "page_up",
  "page_down",
  "wheel_up",
  "wheel_down",
  "top",
  "bottom",
  "other",
])

export interface PerformanceDetail {
  transcriptItems?: number
  visibleBlocks?: number
  viewportRows?: number
  viewportColumns?: number
  action?: PerformanceAction
}

export interface PerformanceMark {
  kind: "submit" | "navigation"
  phase: string
  operationId?: string
  atMs: number
  detail?: Readonly<Record<string, string | number | boolean>>
}

interface StoredMark {
  kind: PerformanceMark["kind"]
  phase: PerformancePhase
  operationId?: string
  atMs: number
  detail?: PerformanceDetail
}

export interface PerformanceProfileSnapshot {
  format: "vimex-performance-trace"
  version: 1
  windowMs: number
  metadata?: PerformanceProfileMetadata
  events: Array<{
    kind: PerformanceMark["kind"]
    phase: PerformancePhase
    atMs: number
    operation?: number
    detail?: PerformanceDetail
  }>
}

export interface PerformanceProfileMetadata {
  vimexVersion?: string
  bunVersion?: string
  os?: "darwin" | "linux" | "win32" | "freebsd" | "openbsd"
  arch?: "arm64" | "x64" | "arm" | "ia32" | "riscv64"
  viewportRows?: number
  viewportColumns?: number
}

function safeMetadata(
  metadata: PerformanceProfileMetadata | undefined,
): PerformanceProfileMetadata | undefined {
  if (!metadata) return undefined
  const safe: PerformanceProfileMetadata = {}
  if (metadata.vimexVersion?.match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/))
    safe.vimexVersion = metadata.vimexVersion
  if (metadata.bunVersion?.match(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/))
    safe.bunVersion = metadata.bunVersion
  if (
    metadata.os === "darwin" ||
    metadata.os === "linux" ||
    metadata.os === "win32" ||
    metadata.os === "freebsd" ||
    metadata.os === "openbsd"
  )
    safe.os = metadata.os
  if (
    metadata.arch === "arm64" ||
    metadata.arch === "x64" ||
    metadata.arch === "arm" ||
    metadata.arch === "ia32" ||
    metadata.arch === "riscv64"
  )
    safe.arch = metadata.arch
  if (
    typeof metadata.viewportRows === "number" &&
    Number.isFinite(metadata.viewportRows) &&
    metadata.viewportRows >= 0
  )
    safe.viewportRows = metadata.viewportRows
  if (
    typeof metadata.viewportColumns === "number" &&
    Number.isFinite(metadata.viewportColumns) &&
    metadata.viewportColumns >= 0
  )
    safe.viewportColumns = metadata.viewportColumns
  return Object.keys(safe).length ? safe : undefined
}

function safeDetail(
  detail: PerformanceMark["detail"],
): PerformanceDetail | undefined {
  if (!detail) return undefined
  const safe: PerformanceDetail = {}
  for (const key of [
    "transcriptItems",
    "visibleBlocks",
    "viewportRows",
    "viewportColumns",
  ] as const) {
    const value = detail[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      safe[key] = value
  }
  if (
    typeof detail.action === "string" &&
    actions.has(detail.action as PerformanceAction)
  )
    safe.action = detail.action as PerformanceAction
  return Object.keys(safe).length ? safe : undefined
}

export class PerformanceProfileRecorder {
  private readonly maxAgeMs: number
  private readonly maxRecords: number
  private readonly now: () => number
  private readonly metadata?: PerformanceProfileMetadata
  private readonly marks: Array<StoredMark | undefined>
  private start = 0
  private length = 0

  constructor(
    options: {
      maxAgeMs?: number
      maxRecords?: number
      now?: () => number
      metadata?: PerformanceProfileMetadata
    } = {},
  ) {
    this.maxAgeMs = Math.min(
      defaultMaxAgeMs,
      Math.max(1, options.maxAgeMs ?? defaultMaxAgeMs),
    )
    this.maxRecords = Math.min(
      hardMaxRecords,
      Math.max(1, Math.floor(options.maxRecords ?? defaultMaxRecords)),
    )
    this.now = options.now ?? (() => performance.now())
    this.metadata = safeMetadata(options.metadata)
    this.marks = new Array(this.maxRecords)
  }

  record(mark: PerformanceMark): void {
    if (
      (mark.kind !== "submit" && mark.kind !== "navigation") ||
      !phases.has(mark.phase) ||
      !Number.isFinite(mark.atMs)
    )
      return

    this.prune(this.now())
    const next: StoredMark = {
      kind: mark.kind,
      phase: mark.phase as PerformancePhase,
      atMs: mark.atMs,
    }
    if (mark.operationId) next.operationId = mark.operationId
    const detail = safeDetail(mark.detail)
    if (detail) next.detail = detail

    const index = (this.start + this.length) % this.maxRecords
    this.marks[index] = next
    if (this.length === this.maxRecords)
      this.start = (this.start + 1) % this.maxRecords
    else this.length++
  }

  snapshot(): PerformanceProfileSnapshot {
    const cutoff = this.now() - this.maxAgeMs
    const retained: StoredMark[] = []
    for (let offset = 0; offset < this.length; offset++) {
      const mark = this.marks[(this.start + offset) % this.maxRecords]
      if (mark && mark.atMs >= cutoff) retained.push(mark)
    }
    const firstAtMs = retained[0]?.atMs ?? 0
    const operations = new Map<string, number>()
    return {
      format: "vimex-performance-trace",
      version: 1,
      windowMs: this.maxAgeMs,
      ...(this.metadata ? { metadata: { ...this.metadata } } : {}),
      events: retained.map((mark) => {
        const event: PerformanceProfileSnapshot["events"][number] = {
          kind: mark.kind,
          phase: mark.phase,
          atMs: Math.round((mark.atMs - firstAtMs) * 1000) / 1000,
        }
        if (mark.operationId) {
          let ordinal = operations.get(mark.operationId)
          if (ordinal === undefined) {
            ordinal = operations.size + 1
            operations.set(mark.operationId, ordinal)
          }
          event.operation = ordinal
        }
        if (mark.detail) event.detail = { ...mark.detail }
        return event
      }),
    }
  }

  async exportTo(path: string): Promise<{ path: string; recordCount: number }> {
    const snapshot = this.snapshot()
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = join(
      directory,
      `.vimex-performance-${crypto.randomUUID()}.tmp`,
    )
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      await rename(temporaryPath, path)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    return { path, recordCount: snapshot.events.length }
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxAgeMs
    while (this.length > 0) {
      const mark = this.marks[this.start]
      if (mark && mark.atMs >= cutoff) break
      this.marks[this.start] = undefined
      this.start = (this.start + 1) % this.maxRecords
      this.length--
    }
  }
}

import { itemId } from "@vimex/conversation"
import {
  beginSelection,
  initialTranscript,
  moveCursor,
  projectPlainText,
  selectedText,
  type TranscriptState,
} from "@vimex/transcript"
import {
  PreparedTextCache,
  type PreparedTextRequest,
} from "./prepared-text-cache"

export interface PreparedViewportBlock {
  readonly id: string
  readonly text: string
  readonly kind?: "plain" | "code"
}
export interface PreparedViewportFrame {
  readonly status: "ready" | "pending" | "fallback"
  readonly rows: readonly string[]
  readonly cursor?: { readonly x: number; readonly y: number }
  readonly top?: {
    readonly blockIndex: number
    readonly itemId: string
    readonly row: number
  }
  readonly pending: number
  readonly accepted: number
  readonly resolved: number
  readonly fallbackReason?: string
}

/** Isolated plain/code experiment. TranscriptState remains the sole semantic
 * cursor/selection/anchor owner. No native work runs in enqueue/advance/frame.
 * A missing destination retains ordered motion and the last complete frame. */
export class PreparedViewportExperiment {
  private current: TranscriptState
  private readonly requests: readonly PreparedTextRequest[]
  private readonly indexById = new Map<string, number>()
  private readonly cache: PreparedTextCache
  private readonly height: number
  private readonly width: number
  private pending: number[] = []
  private needed: number | undefined
  private fallbackReason: string | undefined
  private accepted = 0
  private resolved = 0
  private preparationsWithoutMovement = 0
  private lastPaint:
    Pick<PreparedViewportFrame, "rows" | "cursor" | "top"> | undefined

  constructor(options: {
    blocks: readonly PreparedViewportBlock[]
    width: number
    height: number
    startBlock?: number
  }) {
    if (
      !Number.isSafeInteger(options.width) ||
      options.width < 1 ||
      options.width > 512 ||
      !Number.isSafeInteger(options.height) ||
      options.height < 1 ||
      options.height > 60 ||
      !options.blocks.length
    )
      throw new Error("Invalid prepared viewport dimensions/content")
    const start = options.startBlock ?? 0
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start >= options.blocks.length
    )
      throw new Error("Invalid prepared viewport start block")
    this.width = options.width
    this.height = options.height
    this.cache = new PreparedTextCache({
      viewport: true,
      maxEntries: 128,
      maxBytes: 8 * 1024 * 1024,
      maxQueued: 1,
    })
    const order = options.blocks.map((block) => itemId(block.id))
    const projectionById: TranscriptState["projectionById"] =
      Object.fromEntries(
        options.blocks.map((block) => [
          block.id,
          { ...projectPlainText(block.text), revision: 1 },
        ]),
      )
    options.blocks.forEach((block, index) => {
      if (this.indexById.has(block.id))
        throw new Error("Duplicate prepared viewport identity")
      this.indexById.set(block.id, index)
    })
    this.requests = options.blocks.map((block) => ({
      identity: block.id,
      contentRevision: "1",
      layoutRevision: "prepared-viewport-v1",
      input: {
        text: block.text,
        kind: block.kind ?? "plain",
        width: options.width,
        widthMethod: "unicode",
        wrapMode: "word",
      },
    }))
    this.current = moveCursor(
      { ...initialTranscript(), order, projectionById },
      { itemId: order[start]!, graphemeOffset: 0 },
      0,
    )
  }

  get state() {
    return this.current
  }
  get cacheStats() {
    return this.cache.stats
  }

  enqueue(deltaRows: number): boolean {
    if (
      this.fallbackReason ||
      !Number.isSafeInteger(deltaRows) ||
      deltaRows === 0 ||
      Math.abs(deltaRows) > 4096 ||
      this.pending.length >= 128
    )
      return false
    this.pending.push(deltaRows)
    this.accepted++
    return true
  }

  private fail(reason: string) {
    this.fallbackReason = reason
  }
  private position() {
    const point = this.current.cursor!
    const blockIndex = this.indexById.get(point.itemId)!
    const request = this.requests[blockIndex]!
    const nav = this.cache.getNavigation(request)
    if (!nav) {
      this.needed = blockIndex
      return undefined
    }
    const cell = nav.pointAt(point.graphemeOffset)
    if (!cell) {
      this.fail("unmapped-cursor-row")
      return undefined
    }
    return { blockIndex, row: cell.row, column: cell.column }
  }

  private visible(blockIndex: number, row: number): string[] | undefined {
    const rows: string[] = []
    for (
      let index = blockIndex;
      index < this.requests.length && rows.length < this.height;
      index++
    ) {
      const viewport = this.cache.getViewport(this.requests[index]!)
      if (!viewport) {
        this.needed = index
        return undefined
      }
      const start = index === blockIndex ? row : 0
      for (const line of viewport.rows(start, this.height - rows.length))
        rows.push(line.text)
    }
    while (rows.length < this.height) rows.push("")
    return rows
  }

  /** Resolve at most 128 row steps, retaining exact accepted command order. */
  advance(): number {
    const before = this.resolved
    this.needed = undefined
    if (this.fallbackReason) return 0
    for (let steps = 0; this.pending.length && steps < 128; steps++) {
      const position = this.position()
      if (!position) break
      const direction = Math.sign(this.pending[0]!)
      let blockIndex = position.blockIndex
      let row = position.row + direction
      let layout = this.cache.get(this.requests[blockIndex]!)!
      if (row < 0 || row >= layout.rowCount) {
        const next = blockIndex + direction
        if (next < 0 || next >= this.requests.length) {
          this.pending.shift()
          this.resolved++
          continue
        }
        blockIndex = next
        const nextLayout = this.cache.get(this.requests[blockIndex]!)
        if (!nextLayout) {
          this.needed = blockIndex
          break
        }
        layout = nextLayout
        row = direction > 0 ? 0 : layout.rowCount - 1
      }
      if (!this.visible(blockIndex, row)) break
      const navigation = this.cache.getNavigation(this.requests[blockIndex]!)!
      const nativeRow = layout.row(row)!
      let from = nativeRow.from
      while (from > 0 && (navigation.pointAt(from - 1)?.row ?? -1) >= row)
        from--
      let target: ReturnType<typeof navigation.pointAt>
      for (
        let offset = from;
        offset <= Math.min(layout.graphemeCount, nativeRow.to);
        offset++
      ) {
        const candidate = navigation.pointAt(offset)
        if (candidate?.row !== row) continue
        if (
          !target ||
          Math.abs(candidate.column - position.column) <
            Math.abs(target.column - position.column)
        )
          target = candidate
      }
      if (!target) {
        this.fail("unmapped-destination-row")
        break
      }
      this.current = moveCursor(
        this.current,
        {
          itemId: this.current.order[blockIndex]!,
          graphemeOffset: target.graphemeOffset,
        },
        0,
      )
      this.preparationsWithoutMovement = 0
      this.pending[0]! -= direction
      if (this.pending[0] === 0) {
        this.pending.shift()
        this.resolved++
      }
    }
    return this.resolved - before
  }

  /** Explicit preparation turn; never call from an input handler. */
  prepare() {
    if (this.needed === undefined && !this.fallbackReason) {
      const position = this.position()
      if (position) this.visible(position.blockIndex, position.row)
    }
    if (this.needed === undefined || this.fallbackReason)
      return {
        jobs: 0,
        prepared: 0,
        unsupported: 0,
        unretained: 0,
        remaining: 0,
      }
    if (++this.preparationsWithoutMovement > this.height * 2 + 8) {
      this.fail("viewport-retention-capacity")
      return {
        jobs: 0,
        prepared: 0,
        unsupported: 0,
        unretained: 0,
        remaining: 0,
      }
    }
    const admission = this.cache.replaceRequests([this.requests[this.needed]!])
    if (admission.refused) this.fail("preparation-admission")
    const result = this.cache.drain({ maxJobs: 1, maxMs: 4 })
    if (result.unsupported || result.unretained)
      this.fail("unsupported-or-unretained-block")
    this.needed = undefined
    return result
  }

  frame(): PreparedViewportFrame {
    const position = this.position()
    const rows = position
      ? this.visible(position.blockIndex, position.row)
      : undefined
    if (rows && position)
      this.lastPaint = {
        rows,
        cursor: { x: Math.min(this.width - 1, position.column), y: 0 },
        top: {
          blockIndex: position.blockIndex,
          itemId: this.current.order[position.blockIndex]!,
          row: position.row,
        },
      }
    return {
      status: this.fallbackReason ? "fallback" : rows ? "ready" : "pending",
      ...(this.lastPaint ?? { rows: [] }),
      pending: this.pending.length,
      accepted: this.accepted,
      resolved: this.resolved,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
    }
  }

  beginSelection() {
    this.current = beginSelection(this.current, "character")
  }
  copy(format: "plain" | "source" = "plain") {
    return selectedText(this.current, format)
  }
}

import {
  Renderable,
  TextBufferRenderable,
  TextTableRenderable,
} from "@opentui/core"
import type { NativePoint } from "./measure-rendered-block"

interface Measurement {
  readonly points: Readonly<Record<number, NativePoint>>
  readonly originX: number
  readonly originY: number
}

interface Entry {
  readonly text: string
  readonly inputs: readonly unknown[]
  readonly points: Readonly<Record<number, NativePoint>>
  readonly count: number
  readonly inputUnits: number
}

/** Snapshot precisely the native inputs used by cellsIn/measureRaw. Copy line
 * metadata values: native arrays may be updated in place without resizing. */
function nativeInputs(root: Renderable): readonly unknown[] | undefined {
  const values: unknown[] = []
  let characters = 0
  let supported = true
  const visit = (node: Renderable) => {
    if (!supported || node.id.startsWith("decoration:")) return
    if (node.isDestroyed || node instanceof TextTableRenderable) {
      supported = false
      return
    }
    values.push(
      node,
      node.id,
      node.x - root.x,
      node.y - root.y,
      node.width,
      node.height,
    )
    if (node instanceof TextBufferRenderable) {
      const text = node.plainText
      const info = node.lineInfo
      characters += text.length
      if (
        characters > 65_536 ||
        values.length + info.lineSources.length + info.lineStartCols.length >
          32_760
      ) {
        supported = false
        return
      }
      values.push(
        text,
        info.lineSources.length,
        ...info.lineSources,
        info.lineStartCols.length,
        ...info.lineStartCols,
      )
    }
    if (characters > 65_536 || values.length > 32_768) {
      supported = false
      return
    }
    for (const child of node.getChildren())
      if ("screenX" in child) visit(child as Renderable)
  }
  visit(root)
  return supported ? values : undefined
}

/** One disposable, bounded cache per native Markdown owner. No scheduling or
 * geometry publication: only reuse of verified sub-block-local measurements. */
export class MarkdownMeasurementCache {
  private readonly entries = new Map<Renderable, Entry>()
  private points = 0
  private inputUnits = 0
  hits = 0
  misses = 0

  constructor(
    private readonly maxPoints = 65_536,
    private readonly maxEntries = 512,
    private readonly maxInputUnits = 262_144,
  ) {}

  get size() {
    return this.entries.size
  }
  get pointCount() {
    return this.points
  }

  retain(roots: ReadonlySet<Renderable>): void {
    for (const [root, entry] of this.entries) {
      if (!roots.has(root) || root.isDestroyed) {
        this.entries.delete(root)
        this.points -= entry.count
        this.inputUnits -= entry.inputUnits
      }
    }
  }

  measure(
    root: Renderable,
    text: string,
    read: () => Record<number, NativePoint>,
  ): Measurement {
    const inputs = text.length <= 65_536 ? nativeInputs(root) : undefined
    const previous = this.entries.get(root)
    if (
      inputs &&
      previous?.text === text &&
      previous.inputs.length === inputs.length &&
      previous.inputs.every((value, index) => value === inputs[index])
    ) {
      this.hits++
      this.entries.delete(root)
      this.entries.set(root, previous)
      return { points: previous.points, originX: root.x, originY: root.y }
    }
    this.misses++
    if (previous) {
      this.entries.delete(root)
      this.points -= previous.count
      this.inputUnits -= previous.inputUnits
    }
    const measured = read()
    const count = Object.keys(measured).length
    // Bound snapshot slots plus retained string code units independently of
    // point count: a mostly-unmapped block can still have a large native key.
    const inputUnits = inputs
      ? inputs.reduce<number>(
          (total, value) =>
            total + (typeof value === "string" ? value.length : 1),
          text.length,
        )
      : 0
    if (
      !inputs ||
      count > Math.min(8192, this.maxPoints) ||
      !count ||
      inputUnits > this.maxInputUnits
    )
      return { points: measured, originX: 0, originY: 0 }
    const local: Record<number, NativePoint> = {}
    for (const [offset, point] of Object.entries(measured))
      local[Number(offset)] = Object.freeze({
        ...point,
        x: point.x - root.x,
        y: point.y - root.y,
      })
    const entry = {
      text,
      inputs,
      points: Object.freeze(local),
      count,
      inputUnits,
    }
    this.entries.set(root, entry)
    this.points += count
    this.inputUnits += inputUnits
    while (
      this.points > this.maxPoints ||
      this.entries.size > this.maxEntries ||
      this.inputUnits > this.maxInputUnits
    ) {
      const [oldRoot, old] = this.entries.entries().next().value!
      this.entries.delete(oldRoot)
      this.points -= old.count
      this.inputUnits -= old.inputUnits
    }
    return { points: entry.points, originX: root.x, originY: root.y }
  }
}

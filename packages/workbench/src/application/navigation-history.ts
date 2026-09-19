import type { ThreadId } from "@vimex/conversation"
import { clampTranscript, type LogicalPoint, type ViewportAnchor } from "@vimex/transcript"
import { activeWorkspace, updateWorkspace, type WorkbenchState } from "./workbench-state"

/** Locations are semantic and compact: never retain transcript contents or drafts. */
export interface NavigationLocation {
  threadId: ThreadId
  cursor?: LogicalPoint
  viewport: ViewportAnchor
}
export function navigationLocation(state: WorkbenchState): NavigationLocation | undefined {
  const workspace = activeWorkspace(state)
  return state.activeThreadId && workspace ? { threadId: state.activeThreadId, cursor: workspace.transcript.cursor, viewport: workspace.transcript.viewport } : undefined
}
export class NavigationHistory {
  private initialized = false
  private back: NavigationLocation[] = []
  private forward: NavigationLocation[] = []
  private sourceBack?: NavigationLocation[]
  private sourceForward?: NavigationLocation[]
  clone(): NavigationHistory {
    const copy = new NavigationHistory()
    copy.initialized = this.initialized
    const location = (entry: NavigationLocation): NavigationLocation => ({
      ...entry,
      cursor: entry.cursor && { ...entry.cursor },
      viewport: entry.viewport.kind === "tail" ? entry.viewport : { ...entry.viewport, point: { ...entry.viewport.point } },
    })
    copy.back = this.back.map(location)
    copy.forward = this.forward.map(location)
    copy.sourceBack = this.back
    copy.sourceForward = this.forward
    return copy
  }
  adopt(source: NavigationHistory): void {
    this.initialized = source.initialized
    const adoptLocations = (staged: NavigationLocation[], originals?: NavigationLocation[]): NavigationLocation[] => {
      if (!originals || originals.length !== staged.length) return staged
      for (let index = 0; index < staged.length; index++) {
        const original = originals[index]!, next = staged[index]!
        original.cursor = next.cursor
        original.viewport = next.viewport
      }
      return originals
    }
    this.back = adoptLocations(source.back, source.sourceBack)
    this.forward = adoptLocations(source.forward, source.sourceForward)
  }
  seed(state: WorkbenchState): void {
    if (this.initialized) return
    const workspace = activeWorkspace(state), id = state.activeThreadId
    if (!workspace || !id) return
    this.initialized = true
    const locations = (entries: typeof workspace.transcript.jumps.back) => entries.map(entry => ({ threadId: id, cursor: entry.point, viewport: { kind: "point" as const, ...entry } }))
    this.back = locations(workspace.transcript.jumps.back)
    this.forward = locations(workspace.transcript.jumps.forward)
  }
  reproject(before: WorkbenchState, after: WorkbenchState, threadId: ThreadId): void {
    const previous = before.workspaces[threadId]?.transcript.projectionById
    const current = after.workspaces[threadId]?.transcript.projectionById
    if (!previous || !current || previous === current) return
    const remap = (point: LogicalPoint): LogicalPoint => {
      const from = previous[point.itemId], to = current[point.itemId]
      if (!from || !to || from === to) return point
      const sourceOffset = from.sourceSpans[point.graphemeOffset]?.from ?? from.source.length
      let low = 0, high = to.sourceSpans.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (to.sourceSpans[middle]!.to > sourceOffset) high = middle
        else low = middle + 1
      }
      return { ...point, graphemeOffset: low }
    }
    for (const location of [...this.back, ...this.forward]) {
      if (location.threadId !== threadId) continue
      // Keep the entry identity stable for an in-flight asynchronous resume.
      if (location.cursor) location.cursor = remap(location.cursor)
      if (location.viewport.kind === "point") location.viewport = { ...location.viewport, point: remap(location.viewport.point) }
    }
  }
  record(location: NavigationLocation): void {
    this.back = [...this.back, location].slice(-100)
    this.forward = []
  }
  removeThread(id: ThreadId): void {
    this.back = this.back.filter(location => location.threadId !== id)
    this.forward = this.forward.filter(location => location.threadId !== id)
  }
  peek(direction: "back" | "forward"): NavigationLocation | undefined { return this[direction].at(-1) }
  commit(direction: "back" | "forward", target: NavigationLocation, origin: NavigationLocation): boolean {
    if (this.peek(direction) !== target) return false
    this[direction] = this[direction].slice(0, -1)
    const opposite = direction === "back" ? "forward" : "back"
    this[opposite] = [...this[opposite], origin].slice(-100)
    return true
  }
}

/** Restore atomically so renderers never observe an intermediate cursor viewport. */
export function restoreNavigationLocation(state: WorkbenchState, location: NavigationLocation): WorkbenchState {
  return updateWorkspace(state, location.threadId, workspace => {
    const transcript = workspace.transcript
    const cursor = location.cursor && transcript.projectionById[location.cursor.itemId] ? location.cursor : undefined
    const viewport = location.viewport.kind === "point" && !transcript.projectionById[location.viewport.point.itemId] ? { kind: "tail" as const } : location.viewport
    return {
      ...workspace,
      transcript: clampTranscript({ ...transcript, cursor, viewport, selection: undefined,
        folded: cursor && transcript.folded[cursor.itemId] ? { ...transcript.folded, [cursor.itemId]: false } : transcript.folded }),
      interaction: { ...workspace.interaction, mode: "normal", surface: "transcript", overlay: null, pendingKeys: "", lastNormalSurface: "transcript" },
    }
  })
}

export function hasRecordedJump(before: WorkbenchState, after: WorkbenchState): boolean {
  const previous = activeWorkspace(before)?.transcript.jumps.back ?? []
  const next = activeWorkspace(after)?.transcript.jumps.back ?? []
  return previous.length !== next.length || previous.some((entry, index) => {
    const other = next[index]
    return !other || entry.point.itemId !== other.point.itemId || entry.point.graphemeOffset !== other.point.graphemeOffset || entry.preferredScreenRow !== other.preferredScreenRow
  })
}

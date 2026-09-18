import { type WorkbenchState, type ThreadWorkspace } from "./workbench-state"
import { graphemeCount, clampTranscript } from "@vimex/transcript"
import type { OutgoingMessage } from "@vimex/composer"

export type SavedOutgoingMessage = Pick<OutgoingMessage, "id" | "text" | "intent" | "status" | "reason">

export interface SavedThreadView {
  draft: string
  cursorOffset: number
  folded: ThreadWorkspace["transcript"]["folded"]
  cursor?: ThreadWorkspace["transcript"]["cursor"]
  viewport: ThreadWorkspace["transcript"]["viewport"]
  surface: ThreadWorkspace["interaction"]["surface"]
  /** Unacknowledged text is recoverable, but is never resent without an explicit retry. */
  outbox: readonly SavedOutgoingMessage[]
}
export interface LocalState { version: 1; favoriteThreadIds?: readonly string[]; threads: Record<string, SavedThreadView> }
export const emptyLocalState = (): LocalState => ({ version: 1, threads: {} })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function validPoint(value: unknown): boolean {
  return record(value) && typeof value.itemId === "string" && integer(value.graphemeOffset)
}
export function parseLocalState(value: unknown): LocalState {
  if (!record(value) || value.version !== 1 || !record(value.threads)) throw new Error("Invalid Vimex local state")
  if (value.favoriteThreadIds !== undefined && (!Array.isArray(value.favoriteThreadIds) || value.favoriteThreadIds.some(id => typeof id !== "string" || !id))) throw new Error("Invalid favorite thread IDs")
  for (const [id, view] of Object.entries(value.threads)) {
    if (!id || !record(view) || typeof view.draft !== "string" || !integer(view.cursorOffset) || !record(view.folded) || Object.values(view.folded).some(v => typeof v !== "boolean") || !["transcript", "composer"].includes(String(view.surface))) throw new Error(`Invalid view for thread ${id}`)
    if (view.cursor !== undefined && !validPoint(view.cursor)) throw new Error(`Invalid cursor for thread ${id}`)
    if (!record(view.viewport) || (view.viewport.kind !== "tail" && !(view.viewport.kind === "point" && validPoint(view.viewport.point) && integer(view.viewport.preferredScreenRow)))) throw new Error(`Invalid viewport for thread ${id}`)
    const outbox = view.outbox ?? []
    if (!Array.isArray(outbox) || outbox.some(message => !record(message)
      || typeof message.id !== "string" || !message.id
      || typeof message.text !== "string"
      || !["next-turn", "steer"].includes(String(message.intent))
      || !["queued", "sending", "failed"].includes(String(message.status))
      || (message.reason !== undefined && typeof message.reason !== "string"))) throw new Error(`Invalid outbox for thread ${id}`)
    view.outbox = outbox
  }
  return value as unknown as LocalState
}
export function captureLocalState(state: WorkbenchState, previous: LocalState): LocalState {
  const threads = { ...previous.threads }
  for (const [id, workspace] of Object.entries(state.workspaces)) {
    const { composer, transcript, interaction } = workspace
    // An unvisited session-list entry must never overwrite its saved local view.
    if (!workspace.conversation.turnIds.length && !composer.revision && !transcript.cursor && previous.threads[id]) continue
    threads[id] = {
      draft: composer.text, cursorOffset: composer.cursorOffset,
      folded: transcript.folded, cursor: transcript.cursor, viewport: transcript.viewport, surface: interaction.surface,
      outbox: composer.outbox.map(message => ({ ...message })),
    }
  }
  return { version: 1, threads, favoriteThreadIds: state.favoriteThreadIds }
}
export function restoreThreadView(workspace: ThreadWorkspace, saved: SavedThreadView): ThreadWorkspace {
  const knownPoint = (point: typeof saved.cursor) => point && workspace.transcript.projectionById[point.itemId] ? point : undefined
  const cursor = knownPoint(saved.cursor)
  const viewport = saved.viewport.kind === "point" && !knownPoint(saved.viewport.point) ? { kind: "tail" as const } : saved.viewport
  const transcript = clampTranscript({ ...workspace.transcript, cursor, viewport, folded: Object.fromEntries(Object.entries(saved.folded).filter(([id]) => workspace.transcript.projectionById[id])) })
  const recoveredOutbox = (saved.outbox ?? []).map(message => ({
    ...message,
    status: "failed" as const,
    reason: message.status === "failed" ? message.reason : "Delivery was not confirmed before Vimex closed; retry explicitly to resend",
  }))
  return {
    ...workspace, transcript,
    composer: { ...workspace.composer, text: saved.draft, cursorOffset: Math.min(saved.cursorOffset, graphemeCount(saved.draft)), revision: workspace.composer.revision + 1, outbox: recoveredOutbox },
    interaction: { ...workspace.interaction, mode: "normal", surface: saved.surface, lastNormalSurface: saved.surface },
  }
}

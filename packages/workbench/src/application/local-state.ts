import { type WorkbenchState, type ThreadWorkspace } from "./workbench-state"
import {
  graphemeCount,
  clampTranscript,
  type JumpLocation,
  type TranscriptState,
} from "@vimex/transcript"
import type { OutgoingMessage } from "@vimex/composer"

export type SavedOutgoingMessage = Pick<
  OutgoingMessage,
  "id" | "text" | "intent" | "status" | "reason"
>
export interface SavedTranscriptLocation {
  itemId: string
  sourceOffset: number
  preferredScreenRow: number
}

export interface SavedThreadView {
  draft: string
  cursorOffset: number
  folded: ThreadWorkspace["transcript"]["folded"]
  cursor?: ThreadWorkspace["transcript"]["cursor"]
  viewport: ThreadWorkspace["transcript"]["viewport"]
  surface: ThreadWorkspace["interaction"]["surface"]
  /** Unacknowledged text is recoverable, but is never resent without an explicit retry. */
  outbox: readonly SavedOutgoingMessage[]
  marks?: Readonly<Record<string, SavedTranscriptLocation>>
  jumps?: {
    back: readonly SavedTranscriptLocation[]
    forward: readonly SavedTranscriptLocation[]
  }
}
export interface LocalState {
  version: 1
  sideChats?: Readonly<Record<string, import("./side-chat").SideChat>>
  retiredSideThreadIds?: readonly string[]
  favoriteThreadIds?: readonly string[]
  threads: Record<string, SavedThreadView>
}
export const emptyLocalState = (): LocalState => ({ version: 1, threads: {} })

function savedLocation(
  transcript: TranscriptState,
  location: JumpLocation,
): SavedTranscriptLocation | undefined {
  const projection = transcript.projectionById[location.point.itemId]
  if (!projection) return undefined
  return {
    itemId: location.point.itemId,
    sourceOffset:
      projection.sourceSpans[location.point.graphemeOffset]?.from ??
      projection.source.length,
    preferredScreenRow: location.preferredScreenRow,
  }
}

const sameArray = <T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]),
  )
const samePoint = (
  left: { itemId: string; graphemeOffset: number } | undefined,
  right: { itemId: string; graphemeOffset: number } | undefined,
) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.itemId === right.itemId &&
    left.graphemeOffset === right.graphemeOffset,
  )
const sameLocation = (
  left: SavedTranscriptLocation | undefined,
  right: SavedTranscriptLocation | undefined,
) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.itemId === right.itemId &&
    left.sourceOffset === right.sourceOffset &&
    left.preferredScreenRow === right.preferredScreenRow,
  )
function sameRecord<T>(
  left: Readonly<Record<string, T>>,
  right: Readonly<Record<string, T>>,
  same: (left: T, right: T) => boolean,
): boolean {
  if (left === right) return true
  const leftKeys = Object.keys(left),
    rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && same(left[key]!, right[key]!),
    )
  )
}
function sameSavedLocations(
  before: TranscriptState,
  after: TranscriptState,
): boolean {
  const sameJump = (left: JumpLocation, right: JumpLocation) =>
    sameLocation(savedLocation(before, left), savedLocation(after, right))
  const sameJumps = (
    left: readonly JumpLocation[],
    right: readonly JumpLocation[],
  ) =>
    (left === right && before.projectionById === after.projectionById) ||
    (left.length === right.length &&
      left.every((value, index) => sameJump(value, right[index]!)))
  const beforeMarks = Object.keys(before.marks),
    afterMarks = Object.keys(after.marks)
  const sameMarks =
    (before.marks === after.marks &&
      before.projectionById === after.projectionById) ||
    (beforeMarks.length === afterMarks.length &&
      beforeMarks.every(
        (name) =>
          Object.hasOwn(after.marks, name) &&
          sameJump(before.marks[name]!, after.marks[name]!),
      ))
  return (
    sameMarks &&
    sameJumps(before.jumps.back, after.jumps.back) &&
    sameJumps(before.jumps.forward, after.jumps.forward)
  )
}
function sameWorkspaceView(
  before: ThreadWorkspace,
  after: ThreadWorkspace,
): boolean {
  if (before === after) return true
  const beforeVisited = Boolean(
    before.conversation.turnIds.length ||
    before.composer.revision ||
    before.transcript.cursor,
  )
  const afterVisited = Boolean(
    after.conversation.turnIds.length ||
    after.composer.revision ||
    after.transcript.cursor,
  )
  const sameOutbox =
    before.composer.outbox === after.composer.outbox ||
    (before.composer.outbox.length === after.composer.outbox.length &&
      before.composer.outbox.every((message, index) => {
        const candidate = after.composer.outbox[index]
        return (
          candidate &&
          message.id === candidate.id &&
          message.text === candidate.text &&
          message.intent === candidate.intent &&
          message.status === candidate.status &&
          message.reason === candidate.reason
        )
      }))
  const sameViewport =
    before.transcript.viewport === after.transcript.viewport ||
    (before.transcript.viewport.kind === "tail" &&
      after.transcript.viewport.kind === "tail") ||
    (before.transcript.viewport.kind === "point" &&
      after.transcript.viewport.kind === "point" &&
      samePoint(
        before.transcript.viewport.point,
        after.transcript.viewport.point,
      ) &&
      before.transcript.viewport.preferredScreenRow ===
        after.transcript.viewport.preferredScreenRow)
  return (
    beforeVisited === afterVisited &&
    before.composer.text === after.composer.text &&
    before.composer.cursorOffset === after.composer.cursorOffset &&
    sameOutbox &&
    before.interaction.surface === after.interaction.surface &&
    sameRecord(
      before.transcript.folded,
      after.transcript.folded,
      (left, right) => left === right,
    ) &&
    samePoint(before.transcript.cursor, after.transcript.cursor) &&
    sameViewport &&
    sameSavedLocations(before.transcript, after.transcript)
  )
}
function sameSavedSideChat(
  left: import("./side-chat").SideChat,
  right: import("./side-chat").SideChat,
): boolean {
  return (
    left.parentId === right.parentId &&
    left.threadId === right.threadId &&
    left.visible === right.visible &&
    left.maximized === right.maximized &&
    left.contextLabel === right.contextLabel &&
    sameArray(left.inheritedTurnIds, right.inheritedTurnIds)
  )
}

/** Fast relevance gate for the serialized local-view read model. */
export function localViewChanged(
  before: WorkbenchState,
  after: WorkbenchState,
  changedThreadIds?: readonly string[],
): boolean {
  if (
    !sameArray(before.favoriteThreadIds, after.favoriteThreadIds) ||
    !sameArray(before.retiredSideThreadIds, after.retiredSideThreadIds) ||
    !sameRecord(before.sideChats, after.sideChats, sameSavedSideChat)
  )
    return true
  if (before.workspaces === after.workspaces) return false
  if (changedThreadIds)
    return changedThreadIds.some((id) => {
      const left = before.workspaces[id],
        right = after.workspaces[id]
      return !left || !right || !sameWorkspaceView(left, right)
    })
  return !sameRecord(before.workspaces, after.workspaces, sameWorkspaceView)
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function validPoint(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.itemId === "string" &&
    integer(value.graphemeOffset)
  )
}
function validSavedLocation(value: unknown): value is SavedTranscriptLocation {
  return (
    record(value) &&
    typeof value.itemId === "string" &&
    integer(value.sourceOffset) &&
    typeof value.preferredScreenRow === "number" &&
    Number.isFinite(value.preferredScreenRow)
  )
}
export function parseLocalState(value: unknown): LocalState {
  if (!record(value) || value.version !== 1 || !record(value.threads))
    throw new Error("Invalid Vimex local state")
  if (
    value.favoriteThreadIds !== undefined &&
    (!Array.isArray(value.favoriteThreadIds) ||
      value.favoriteThreadIds.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("Invalid favorite thread IDs")
  if (
    value.retiredSideThreadIds !== undefined &&
    (!Array.isArray(value.retiredSideThreadIds) ||
      value.retiredSideThreadIds.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("Invalid retired side threads")
  if (
    value.sideChats !== undefined &&
    (!record(value.sideChats) ||
      Object.entries(value.sideChats).some(
        ([id, side]) =>
          !record(side) ||
          side.parentId !== id ||
          typeof side.threadId !== "string" ||
          typeof side.visible !== "boolean" ||
          typeof side.maximized !== "boolean" ||
          (side.inheritedTurnIds !== undefined &&
            (!Array.isArray(side.inheritedTurnIds) ||
              side.inheritedTurnIds.some(
                (id) => typeof id !== "string" || !id,
              ))),
      ))
  )
    throw new Error("Invalid side chats")
  for (const [id, view] of Object.entries(value.threads)) {
    if (
      !id ||
      !record(view) ||
      typeof view.draft !== "string" ||
      !integer(view.cursorOffset) ||
      !record(view.folded) ||
      Object.values(view.folded).some((v) => typeof v !== "boolean") ||
      !["transcript", "composer"].includes(String(view.surface))
    )
      throw new Error(`Invalid view for thread ${id}`)
    if (view.cursor !== undefined && !validPoint(view.cursor))
      throw new Error(`Invalid cursor for thread ${id}`)
    if (
      view.marks !== undefined &&
      (!record(view.marks) ||
        Object.entries(view.marks).some(
          ([name, location]) =>
            !/^[a-zA-Z]$/.test(name) || !validSavedLocation(location),
        ))
    )
      throw new Error(`Invalid marks for thread ${id}`)
    if (
      view.jumps !== undefined &&
      (!record(view.jumps) ||
        !Array.isArray(view.jumps.back) ||
        !Array.isArray(view.jumps.forward) ||
        [...view.jumps.back, ...view.jumps.forward].some(
          (location) => !validSavedLocation(location),
        ))
    )
      throw new Error(`Invalid jumps for thread ${id}`)
    if (
      !record(view.viewport) ||
      (view.viewport.kind !== "tail" &&
        !(
          view.viewport.kind === "point" &&
          validPoint(view.viewport.point) &&
          integer(view.viewport.preferredScreenRow)
        ))
    )
      throw new Error(`Invalid viewport for thread ${id}`)
    const outbox = view.outbox ?? []
    if (
      !Array.isArray(outbox) ||
      outbox.some(
        (message) =>
          !record(message) ||
          typeof message.id !== "string" ||
          !message.id ||
          typeof message.text !== "string" ||
          !["next-turn", "steer"].includes(String(message.intent)) ||
          !["queued", "sending", "failed"].includes(String(message.status)) ||
          (message.reason !== undefined && typeof message.reason !== "string"),
      )
    )
      throw new Error(`Invalid outbox for thread ${id}`)
    view.outbox = outbox
  }
  return value as unknown as LocalState
}
export function captureLocalState(
  state: WorkbenchState,
  previous: LocalState,
): LocalState {
  const threads = { ...previous.threads }
  for (const [id, workspace] of Object.entries(state.workspaces)) {
    const { composer, transcript, interaction } = workspace
    // An unvisited session-list entry must never overwrite its saved local view.
    if (
      !workspace.conversation.turnIds.length &&
      !composer.revision &&
      !transcript.cursor &&
      previous.threads[id]
    )
      continue
    threads[id] = {
      draft: composer.text,
      cursorOffset: composer.cursorOffset,
      folded: transcript.folded,
      cursor: transcript.cursor,
      viewport: transcript.viewport,
      surface: interaction.surface,
      outbox: composer.outbox.map((message) => ({ ...message })),
      marks: Object.fromEntries(
        Object.entries(transcript.marks).flatMap(([name, location]) => {
          const saved = savedLocation(transcript, location)
          return saved ? [[name, saved]] : []
        }),
      ),
      jumps: {
        back: transcript.jumps.back.flatMap((location) => {
          const saved = savedLocation(transcript, location)
          return saved ? [saved] : []
        }),
        forward: transcript.jumps.forward.flatMap((location) => {
          const saved = savedLocation(transcript, location)
          return saved ? [saved] : []
        }),
      },
    }
  }
  for (const id of state.retiredSideThreadIds) delete threads[id]
  return {
    version: 1,
    threads,
    favoriteThreadIds: state.favoriteThreadIds,
    retiredSideThreadIds: state.retiredSideThreadIds,
    sideChats: Object.fromEntries(
      Object.entries(state.sideChats)
        .filter(([, side]) => side.threadId)
        .map(([id, side]) => [id, { ...side, status: undefined }]),
    ),
  }
}
export function restoreThreadView(
  workspace: ThreadWorkspace,
  saved: SavedThreadView,
): ThreadWorkspace {
  const knownPoint = (point: typeof saved.cursor) =>
    point && workspace.transcript.projectionById[point.itemId]
      ? point
      : undefined
  const cursor = knownPoint(saved.cursor)
  const viewport =
    saved.viewport.kind === "point" && !knownPoint(saved.viewport.point)
      ? { kind: "tail" as const }
      : saved.viewport
  const restoreLocation = (
    location: SavedTranscriptLocation,
  ): JumpLocation | undefined => {
    const projection = workspace.transcript.projectionById[location.itemId]
    if (!projection) return undefined
    const graphemeOffset = projection.sourceSpans.findIndex(
      (span) => span.to > location.sourceOffset,
    )
    return {
      point: {
        itemId: location.itemId as JumpLocation["point"]["itemId"],
        graphemeOffset:
          graphemeOffset < 0 ? projection.sourceSpans.length : graphemeOffset,
      },
      preferredScreenRow: Math.trunc(location.preferredScreenRow),
    }
  }
  const marks = Object.fromEntries(
    Object.entries(saved.marks ?? {}).flatMap(([name, location]) => {
      const restored = restoreLocation(location)
      return restored ? [[name, restored]] : []
    }),
  )
  const jumps = {
    back: (saved.jumps?.back ?? [])
      .flatMap((location) => {
        const restored = restoreLocation(location)
        return restored ? [restored] : []
      })
      .slice(-100),
    forward: (saved.jumps?.forward ?? [])
      .flatMap((location) => {
        const restored = restoreLocation(location)
        return restored ? [restored] : []
      })
      .slice(-100),
  }
  const transcript = clampTranscript({
    ...workspace.transcript,
    cursor,
    viewport,
    marks,
    jumps,
    folded: Object.fromEntries(
      Object.entries(saved.folded).filter(([id]) => {
        const projection = workspace.transcript.projectionById[id]
        return projection && projection.nodeKind !== "message"
      }),
    ),
  })
  const recoveredOutbox = (saved.outbox ?? []).map((message) => ({
    ...message,
    status: "failed" as const,
    reason:
      message.status === "failed"
        ? message.reason
        : "Delivery was not confirmed before Vimex closed; retry explicitly to resend",
  }))
  return {
    ...workspace,
    transcript,
    composer: {
      ...workspace.composer,
      text: saved.draft,
      cursorOffset: Math.min(saved.cursorOffset, graphemeCount(saved.draft)),
      revision: workspace.composer.revision + 1,
      outbox: recoveredOutbox,
    },
    interaction: {
      ...workspace.interaction,
      mode: "normal",
      surface: saved.surface,
      lastNormalSurface: saved.surface,
    },
  }
}

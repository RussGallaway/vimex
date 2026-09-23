import {
  itemId,
  persistentConversationItems,
  persistentConversationTurnIds,
  persistentConversationTurns,
  persistentTurnItemIds,
  threadId,
  turnId,
  type ConversationItem,
  type ConversationState,
  type ItemId,
  type ThreadId,
  type Turn,
  type TurnId,
} from "@vimex/conversation"
import {
  buildTranscriptBlocks,
  initialTranscript,
  persistentTranscriptFolds,
  persistentTranscriptOrder,
  persistentTranscriptProjections,
  projectItem,
  projectsToTranscript,
  type TranscriptState,
} from "@vimex/transcript"
import type { TranscriptFixtureSnapshot } from "./transcript-builders"

export type TranscriptNavigationShape =
  "mixed" | "command" | "tool" | "agent" | "edit" | "markdown"

export interface TranscriptNavigationFixtureOptions {
  /** Number of canonical items, including the running tail. Some canonical events are not transcript items. */
  readonly blockCount: number
  readonly shape?: TranscriptNavigationShape
}

export interface TranscriptNavigationFixture {
  readonly fixtureVersion: "transcript-navigation-v1"
  readonly shape: TranscriptNavigationShape
  readonly requestedBlockCount: number
  readonly transcriptItemCount: number
  /** Exact production render-block count, including fragments and turn activity. */
  readonly blockCount: number
  readonly threadId: ThreadId
  readonly tailItemId: ItemId
  readonly landmarks: Readonly<{
    first: ItemId
    quarter: ItemId
    middle: ItemId
    threeQuarter: ItemId
    tail: ItemId
    folded: ItemId
    expanded: ItemId
    large: ItemId
  }>
  readonly before: TranscriptFixtureSnapshot
  readonly contentHash: string
}

const fixtureVersion = "transcript-navigation-v1"
const shortMarkdown =
  "The transcript stays readable while [reviewing](https://vimex.test/review) older work."
const richMarkdown = [
  [
    "## Investigation 🧭",
    "| Source | Finding |",
    "| --- | --- |",
    "| parser | Unicode: café, 東京, 👨‍👩‍👧‍👦 |",
    "",
    "```ts",
    "const result = inputs.map((entry) => entry.status)",
    "```",
  ].join("\n"),
  ...Array.from(
    { length: 72 },
    (_, index) =>
      `Paragraph ${index}: ${"measured scrollback content ".repeat(3)}[source](https://vimex.test/${index}).`,
  ),
].join("\n\n")
const longCommand = Array.from(
  { length: 96 },
  (_, index) =>
    `${String(index).padStart(4, "0")}: ${"compile output ".repeat(7)}${index % 7 === 0 ? " ⚙" : ""}`,
).join("\n")
const shortCommand = "$ bun run check\n✓ types\n✓ boundaries\n✓ tests"
const diff = (path: string, itemIndex: number, fileIndex: number) => {
  const marker = `item-${itemIndex}-file-${fileIndex}`
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n export const ${marker.replaceAll("-", "_")} = {\n-  state: "before-${marker}",\n+  state: "after-${marker}",\n }`
}

function hashText(hash: number, value: string): number {
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return hash >>> 0
}

function sourceOf(item: ConversationItem): string {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return item.markdown
    case "command":
    case "tool":
      return [item.title, item.executionCommand, item.detail]
        .filter(Boolean)
        .join("\n")
    case "agent":
      return item.detail
    case "edit":
      return item.patch
    case "unknown":
      return [item.title, item.detail].filter(Boolean).join("\n")
  }
}

function mixedItem(id: ItemId, turn: TurnId, index: number): ConversationItem {
  const long = Math.floor(index / 16) % 4 === 0
  switch (index % 16) {
    case 0:
      return {
        id,
        turnId: turn,
        kind: "user",
        markdown: "Review the latest changes and report anything surprising.",
        status: "complete",
      }
    case 1:
      return {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: shortMarkdown,
        status: "complete",
      }
    case 2:
    case 3:
    case 4:
      return {
        id,
        turnId: turn,
        kind: "tool",
        title: `Search repository #${index}`,
        detail: `Tool #${index}: found ${(index % 5) + 1} relevant files.`,
        activity: { family: "read" },
        status: "complete",
      }
    case 5:
      return {
        id,
        turnId: turn,
        kind: "agent",
        action: "spawn",
        detail: `Agent #${index}: inspect transcript rendering and report layout gaps.`,
        agentThreadIds: [threadId("fixture-child-a")],
        childTasks: [
          {
            threadId: threadId("fixture-child-a"),
            status: "running",
            message: "Reading renderer paths",
          },
        ],
        status: "complete",
      }
    case 6:
      return {
        id,
        turnId: turn,
        kind: "command",
        title: `Run checks #${index}`,
        executionCommand: "bun run check",
        detail: long ? longCommand : shortCommand,
        status: "complete",
      }
    case 7:
      return {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: long
          ? richMarkdown
          : "## Interim result\n\nThe [layout](https://vimex.test/layout) still needs measurement.",
        status: "complete",
      }
    case 8: {
      const paths = [
        "packages/ui/src/transcript.tsx",
        "packages/transcript/src/window.ts",
        "scripts/bench.ts",
      ]
      const changes = paths.map((path, file) => ({
        path,
        action: "update" as const,
        patch: diff(path, index, file),
      }))
      return {
        id,
        turnId: turn,
        kind: "edit",
        title: `Update three files #${index}`,
        patch: changes.map((change) => change.patch).join("\n"),
        changes,
        status: "complete",
      }
    }
    case 9: {
      const path = "packages/transcript/src/navigation.ts"
      const patch = diff(path, index, 0)
      return {
        id,
        turnId: turn,
        kind: "edit",
        title: `Adjust navigation #${index}`,
        patch,
        changes: [{ path, action: "update", patch }],
        status: "complete",
      }
    }
    case 10:
      return {
        id,
        turnId: turn,
        kind: "agent",
        action: "activity",
        activity: "interacted",
        agentPath: "/root/fixture-child-a",
        detail: `Agent #${index}: measured the cold upward scroll and sent timing notes.`,
        agentThreadIds: [threadId("fixture-child-a")],
        status: "complete",
      }
    case 11:
      return {
        id,
        turnId: turn,
        kind: "unknown",
        title: "Unrecognized provider event",
        detail: "Diagnostic payload retained for transcript navigation.",
        transcript: "diagnostic",
        status: "complete",
      }
    case 12:
      return {
        id,
        turnId: turn,
        kind: "reasoning",
        markdown:
          "Compare the benchmark with the dense reference before changing the layout policy.",
        status: "complete",
      }
    case 13:
      return {
        id,
        turnId: turn,
        kind: "tool",
        title: `Web research #${index}`,
        detail: `Tool #${index}: fetched upstream scrolling documentation.`,
        activity: { family: "web-research" },
        status: "complete",
      }
    case 14:
      return {
        id,
        turnId: turn,
        kind: "tool",
        title: `Provider call #${index}`,
        detail: `Tool #${index}: received structured tool response.`,
        activity: { family: "provider", label: "Fixture provider" },
        status: "complete",
      }
    default:
      return {
        id,
        turnId: turn,
        kind: "unknown",
        title: `Visible provider event #${index}`,
        detail: "This provider event belongs in the navigable transcript.",
        status: "complete",
      }
  }
}

function isolatedItem(
  shape: Exclude<TranscriptNavigationShape, "mixed">,
  id: ItemId,
  turn: TurnId,
  index: number,
): ConversationItem {
  switch (shape) {
    case "command":
      return {
        id,
        turnId: turn,
        kind: "command",
        title: `Command output #${index}`,
        executionCommand: "bun run check",
        detail: index % 8 === 0 ? longCommand : shortCommand,
        status: "complete",
      }
    case "tool":
      return {
        id,
        turnId: turn,
        kind: "tool",
        title: `${index % 3 === 0 ? "Read files" : "Search files"} #${index}`,
        detail: `Tool result #${index}: source matches and summary.`,
        activity: { family: index % 3 === 0 ? "read" : "web-research" },
        status: "complete",
      }
    case "agent":
      return index % 2 === 0
        ? {
            id,
            turnId: turn,
            kind: "agent",
            action: "spawn",
            detail: `Agent #${index}: inspect a focused navigation scenario.`,
            agentThreadIds: [threadId("fixture-child-a")],
            childTasks: [
              { threadId: threadId("fixture-child-a"), status: "running" },
            ],
            status: "complete",
          }
        : {
            id,
            turnId: turn,
            kind: "agent",
            action: "activity",
            activity: "completed",
            agentPath: "/root/fixture-child-a",
            detail: `Agent #${index}: finished navigation analysis.`,
            agentThreadIds: [threadId("fixture-child-a")],
            status: "complete",
          }
    case "edit": {
      const count = index % 4 === 0 ? 3 : 1
      const changes = Array.from({ length: count }, (_, file) => {
        const path = `packages/fixture/file-${file}.ts`
        return {
          path,
          action: "update" as const,
          patch: diff(path, index, file),
        }
      })
      return {
        id,
        turnId: turn,
        kind: "edit",
        title: `${count} file change #${index}`,
        patch: changes.map((change) => change.patch).join("\n"),
        changes,
        status: "complete",
      }
    }
    case "markdown":
      return {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: index % 8 === 0 ? richMarkdown : shortMarkdown,
        status: "complete",
      }
  }
}

/** Deterministic canonical history for cold/warm navigation benchmarks. */
export function buildTranscriptNavigationFixture(
  options: TranscriptNavigationFixtureOptions,
): TranscriptNavigationFixture {
  const requestedBlockCount = options.blockCount
  if (!Number.isInteger(requestedBlockCount) || requestedBlockCount < 2)
    throw new RangeError("blockCount must be an integer of at least 2")
  const shape = options.shape ?? "mixed"
  if (
    !["mixed", "command", "tool", "agent", "edit", "markdown"].includes(shape)
  )
    throw new RangeError(`unknown transcript navigation shape: ${shape}`)

  const fixtureThread = threadId(`navigation-${shape}-${requestedBlockCount}`)
  const width = String(requestedBlockCount - 1).length
  const transcriptIds: ItemId[] = []
  const turnIds: TurnId[] = []
  const turns: Record<string, Turn> = {}
  const items: Record<string, ConversationItem> = {}
  const projections: Record<string, ReturnType<typeof projectItem>> = {}
  const projectionCache = new Map<string, ReturnType<typeof projectItem>>()
  const folded: Record<string, boolean> = {}
  let currentTurnIds: ItemId[] = []
  let currentTurn = turnId("navigation-turn-0")
  let contentHash = hashText(
    2_166_136_261,
    `${fixtureVersion}:${shape}:${requestedBlockCount}`,
  )
  let firstFolded: ItemId | undefined
  let firstExpanded: ItemId | undefined
  let firstLarge: ItemId | undefined

  const finishTurn = (group: number) => {
    if (!currentTurnIds.length) return
    const status = "complete" as const
    const durationMs =
      shape === "mixed" && group % 2 === 0 ? 180 + (group % 17) : undefined
    turns[currentTurn] = Object.freeze({
      id: currentTurn,
      status,
      itemIds: persistentTurnItemIds(currentTurnIds),
      ...(durationMs === undefined ? {} : { durationMs }),
    })
    turnIds.push(currentTurn)
    currentTurnIds = []
  }

  for (let index = 0; index < requestedBlockCount - 1; index++) {
    const group = Math.floor(index / 16)
    if (index > 0 && index % 16 === 0) {
      finishTurn(group - 1)
      currentTurn = turnId(`navigation-turn-${group}`)
    }
    const id = itemId(
      `navigation-${shape}-${String(index).padStart(width, "0")}`,
    )
    const item = Object.freeze(
      shape === "mixed"
        ? mixedItem(id, currentTurn, index)
        : isolatedItem(shape, id, currentTurn, index),
    )
    currentTurnIds.push(id)
    items[id] = item
    const source = sourceOf(item)
    const visible = projectsToTranscript(item)
    if (visible) {
      transcriptIds.push(id)
      const projectionKey = `${item.kind}\u0000${source}`
      let projection = projectionCache.get(projectionKey)
      if (!projection) {
        projection = projectItem(item)
        projectionCache.set(projectionKey, projection)
      }
      projections[id] = projection
    }
    contentHash = hashText(hashText(contentHash, id), JSON.stringify(item))
    const isLarge =
      source.length > 4_096 ||
      (item.kind === "edit" && (item.changes?.length ?? 0) > 1)
    if (visible && isLarge && !firstLarge) firstLarge = id
    if (visible && index % 11 === 6 && !firstFolded && item.kind !== "user") {
      folded[id] = true
      firstFolded = id
    } else if (visible && index % 19 === 8 && item.kind !== "user") {
      folded[id] = true
    } else if (visible && !firstExpanded && isLarge) {
      firstExpanded = id
    }
  }
  finishTurn(Math.floor((requestedBlockCount - 2) / 16))
  const tailItemId = itemId(
    `navigation-${shape}-${String(requestedBlockCount - 1).padStart(width, "0")}`,
  )
  const tailTurnId = turnId("navigation-running-tail")
  const tailItem = Object.freeze({
    id: tailItemId,
    turnId: tailTurnId,
    kind: "assistant" as const,
    markdown: "Streaming tail: output continues while history is detached.",
    status: "running" as const,
  })
  transcriptIds.push(tailItemId)
  items[tailItemId] = tailItem
  projections[tailItemId] = projectItem(tailItem)
  turns[tailTurnId] = Object.freeze({
    id: tailTurnId,
    status: "running",
    itemIds: persistentTurnItemIds([tailItemId]),
  })
  turnIds.push(tailTurnId)
  contentHash = hashText(hashText(contentHash, tailItemId), tailItem.markdown)

  const pointAt = (fraction: number) =>
    transcriptIds[Math.floor((transcriptIds.length - 1) * fraction)]!
  const landmarks = Object.freeze({
    first: transcriptIds[0]!,
    quarter: pointAt(0.25),
    middle: pointAt(0.5),
    threeQuarter: pointAt(0.75),
    tail: tailItemId,
    folded: firstFolded ?? transcriptIds[0]!,
    expanded: firstExpanded ?? transcriptIds[0]!,
    large: firstLarge ?? transcriptIds[0]!,
  })
  const conversation: ConversationState = Object.freeze({
    threadId: fixtureThread,
    turnIds: persistentConversationTurnIds(turnIds),
    turns: persistentConversationTurns(turns),
    items: persistentConversationItems(items),
    activeTurnId: tailTurnId,
  })
  const transcript: TranscriptState = Object.freeze({
    ...initialTranscript(),
    order: persistentTranscriptOrder(transcriptIds),
    projectionById: persistentTranscriptProjections(projections),
    folded: persistentTranscriptFolds(folded),
    cursor: { itemId: tailItemId, graphemeOffset: 0 },
  })
  const before = Object.freeze({
    canonicalRevision: 1,
    conversation,
    transcript,
  })
  const blockCount = buildTranscriptBlocks(before).length
  return Object.freeze({
    fixtureVersion,
    shape,
    requestedBlockCount,
    transcriptItemCount: transcriptIds.length,
    blockCount,
    threadId: fixtureThread,
    tailItemId,
    landmarks,
    before,
    contentHash: contentHash.toString(16).padStart(8, "0"),
  })
}

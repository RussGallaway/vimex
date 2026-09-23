import { expect, test } from "bun:test"
import {
  buildTranscriptBlocks,
  projectsToTranscript,
  type TranscriptBlock,
  type TranscriptItemBlock,
} from "@vimex/transcript"
import {
  buildTranscriptNavigationFixture,
  type TranscriptNavigationShape,
} from "./transcript-navigation-fixture"

const isItemBlock = (block: TranscriptBlock): block is TranscriptItemBlock =>
  block.key.kind === "item"

test("dirty mixed history keeps semantic and render chronology aligned", () => {
  const fixture = buildTranscriptNavigationFixture({ blockCount: 256 })
  const { conversation, transcript } = fixture.before
  const blocks = buildTranscriptBlocks(fixture.before)
  const kinds = new Set(
    Object.values(conversation.items).map((item) => item.kind),
  )

  expect(kinds).toEqual(
    new Set([
      "user",
      "assistant",
      "tool",
      "agent",
      "command",
      "edit",
      "unknown",
      "reasoning",
    ]),
  )
  expect(fixture.blockCount).toBe(blocks.length)
  expect(blocks.length).toBeGreaterThan(fixture.requestedBlockCount)
  expect(Object.keys(conversation.items)).toHaveLength(256)
  expect(transcript.order).toHaveLength(fixture.transcriptItemCount)
  expect(transcript.order.length).toBeLessThan(256)
  expect(new Set(transcript.order)).toEqual(
    new Set(
      Object.values(conversation.items)
        .filter(projectsToTranscript)
        .map((item) => item.id),
    ),
  )
  expect(Object.keys(transcript.projectionById)).toHaveLength(
    fixture.transcriptItemCount,
  )
  expect(
    transcript.order.some((id) => conversation.items[id]?.kind === "unknown"),
  ).toBe(true)
  expect(
    transcript.order.some((id) => conversation.items[id]?.kind === "reasoning"),
  ).toBe(false)
  expect(
    transcript.order.some((id) => {
      const item = conversation.items[id]
      return item?.kind === "unknown" && item.transcript === "diagnostic"
    }),
  ).toBe(false)
  expect(conversation.turnIds.length).toBeGreaterThan(10)
  expect(blocks.some((block) => block.key.kind === "turn-activity")).toBe(true)
  expect(
    blocks
      .filter(isItemBlock)
      .some((block) => block.fragment?.kind === "command-output"),
  ).toBe(true)
  expect(
    blocks
      .filter(isItemBlock)
      .some((block) => block.fragment?.kind === "markdown"),
  ).toBe(true)
  expect(
    blocks
      .filter(isItemBlock)
      .some((block) => block.fragment?.kind === "edit-file"),
  ).toBe(true)
  expect(transcript.folded[fixture.landmarks.folded]).toBe(true)
  expect(transcript.folded[fixture.landmarks.expanded]).toBeUndefined()
  expect(conversation.items[fixture.tailItemId]?.status).toBe("running")
  expect(conversation.activeTurnId).toBe(
    conversation.items[fixture.tailItemId]?.turnId,
  )
  expect(conversation.turns[conversation.activeTurnId!]?.status).toBe("running")

  const itemBlocks = blocks.filter(isItemBlock)
  for (const block of itemBlocks) {
    expect(conversation.items[block.key.itemId]).toBeDefined()
    expect(transcript.projectionById[block.key.itemId]).toBeDefined()
    expect(block.sourceSpan.to).toBeLessThanOrEqual(
      block.projection.source.length,
    )
  }
})

test.each(["command", "tool", "agent", "edit", "markdown"] as const)(
  "%s fixture isolates one dominant content family",
  (shape: TranscriptNavigationShape) => {
    const fixture = buildTranscriptNavigationFixture({ blockCount: 100, shape })
    const blocks = buildTranscriptBlocks(fixture.before)
    const items = Object.values(fixture.before.conversation.items)
    const expectedKind = shape === "markdown" ? "assistant" : shape
    expect(items.slice(0, -1).every((item) => item.kind === expectedKind)).toBe(
      true,
    )
    expect(items.at(-1)?.kind).toBe("assistant")
    expect(items.at(-1)?.status).toBe("running")
    expect(blocks.length).toBe(fixture.blockCount)
    expect(fixture.before.transcript.order).toHaveLength(100)
    expect(fixture.before.transcript.folded[fixture.landmarks.folded]).toBe(
      true,
    )
    if (shape === "command" || shape === "edit" || shape === "markdown")
      expect(blocks.filter(isItemBlock).some((block) => block.fragment)).toBe(
        true,
      )
    expect(blocks.some((block) => block.key.kind === "turn-activity")).toBe(
      false,
    )
  },
)

test("navigation fixture content and landmarks are deterministic", () => {
  const first = buildTranscriptNavigationFixture({ blockCount: 128 })
  const second = buildTranscriptNavigationFixture({ blockCount: 128 })
  expect(first.contentHash).toBe("18e0eab9")
  expect(first.contentHash).toBe(second.contentHash)
  expect(first.blockCount).toBe(second.blockCount)
  expect(first.landmarks).toEqual(second.landmarks)
  expect(first.before.transcript.order).toEqual(second.before.transcript.order)
  expect(first.contentHash).not.toBe(
    buildTranscriptNavigationFixture({ blockCount: 128, shape: "tool" })
      .contentHash,
  )
})

test("visible edit hunks and ordinary activity identify their semantic item", () => {
  const fixture = buildTranscriptNavigationFixture({ blockCount: 64 })
  const { items } = fixture.before.conversation
  const ids = Object.keys(items)
  const firstEdit = items[ids[8]!]!
  const nextEdit = items[ids[24]!]!
  expect(firstEdit.kind).toBe("edit")
  expect(nextEdit.kind).toBe("edit")
  if (firstEdit.kind !== "edit" || nextEdit.kind !== "edit") return
  expect(fixture.before.transcript.order).toContain(firstEdit.id)
  expect(fixture.before.transcript.order).toContain(nextEdit.id)

  expect(firstEdit.changes).toHaveLength(3)
  const changedLines = firstEdit.changes!.map((change) =>
    change.patch
      .split("\n")
      .filter(
        (line) =>
          (line.startsWith("+") && !line.startsWith("+++")) ||
          (line.startsWith("-") && !line.startsWith("---")),
      )
      .join("\n"),
  )
  expect(new Set(changedLines).size).toBe(3)
  for (const [file, lines] of changedLines.entries()) {
    expect(lines).toContain(`item-8-file-${file}`)
    expect(lines).not.toContain("item-24-file-")
    expect(nextEdit.patch).toContain(`item-24-file-${file}`)
  }
  for (const index of [2, 5, 6, 8, 9, 10, 13, 14]) {
    const item = items[ids[index]!]!
    expect(JSON.stringify(item)).toContain(`#${index}`)
  }
})

test("navigation fixture rejects invalid sizes and shapes", () => {
  expect(() => buildTranscriptNavigationFixture({ blockCount: 1 })).toThrow(
    RangeError,
  )
  expect(() => buildTranscriptNavigationFixture({ blockCount: 1.5 })).toThrow(
    RangeError,
  )
  expect(() =>
    buildTranscriptNavigationFixture({
      blockCount: 100,
      shape: "bogus" as TranscriptNavigationShape,
    }),
  ).toThrow(RangeError)
})

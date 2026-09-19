import { expect, test } from "bun:test"
import { forkBoundary } from "@vimex/conversation"
import { buildTranscriptBlocks, findSearchMatches, projectItem, referenceText, selectedText, urlCandidates } from "@vimex/transcript"
import {
  appendTranscriptScalingTail,
  buildOversizedTranscriptFixtures,
  buildTranscriptScalingFixture,
  transcriptScalingBlockCounts,
} from "./transcript-builders"

test("scaling fixtures deterministically produce the exact requested render-block counts", () => {
  for (const blockCount of transcriptScalingBlockCounts) {
    const fixture = buildTranscriptScalingFixture(blockCount)
    const blocks = buildTranscriptBlocks(fixture.before)
    expect(blocks).toHaveLength(blockCount)
    expect(fixture.before.transcript.order).toHaveLength(blockCount)
    expect(Object.keys(fixture.before.conversation.items)).toHaveLength(blockCount)
    expect(blocks[0]?.key).toEqual({ kind: "item", itemId: fixture.targets.first, blockId: "root" })
    expect(blocks.at(-1)?.key).toEqual({ kind: "item", itemId: fixture.tailItemId, blockId: "root" })
    expect(blocks.some(block => block.key.kind === "turn-activity")).toBe(false)
    expect(fixture.before.conversation.turns[fixture.historyTurnId]?.status).toBe("complete")
    expect(fixture.before.conversation.turns[fixture.turnId]?.status).toBe("running")
    expect(fixture.before.conversation.items[fixture.targets.first]?.kind).toBe("user")
    expect(fixture.before.conversation.items[fixture.targets.quarter]?.kind).toBe("assistant")
    expect(fixture.before.conversation.items[fixture.targets.selectionEnd]?.kind).toBe("command")
    expect(fixture.before.conversation.items[fixture.targets.middle]?.kind).toBe("edit")
    expect(fixture.before.conversation.items[fixture.targets.threeQuarter]?.kind).toBe("reasoning")
    expect(fixture.before.transcript.projectionById[fixture.targets.threeQuarter]?.nodeKind).toBe("reasoning")
    expect(fixture.before.transcript.folded[fixture.targets.threeQuarter]).toBe(true)
    expect(fixture.afterTailDelta.transcript.order).toBe(fixture.before.transcript.order)
    expect(fixture.afterTailDelta.conversation.items[fixture.targets.first]).toBe(fixture.before.conversation.items[fixture.targets.first])
    expect(fixture.afterTailDelta.transcript.projectionById[fixture.targets.first]).toBe(fixture.before.transcript.projectionById[fixture.targets.first])
  }
})

test("scaling fixtures carry meaningful off-window semantic boundaries", () => {
  const fixture = buildTranscriptScalingFixture(100)
  expect(fixture.before.transcript.selection?.anchor.itemId).toBe(fixture.targets.quarter)
  expect(fixture.before.transcript.selection?.head.itemId).toBe(fixture.targets.selectionEnd)
  expect(selectedText(fixture.before.transcript, "plain")).toContain("Selection command boundary")
  expect(selectedText(fixture.before.transcript, "source")).toContain("[fixture link](https://vimex.test/selection)")
  expect(referenceText(fixture.before.transcript, "source")).toBe(selectedText(fixture.before.transcript, "source"))
  expect(findSearchMatches(fixture.before.transcript, fixture.before.transcript.search?.query ?? "").length).toBeGreaterThan(0)
  expect(urlCandidates(fixture.before.transcript, "selection").map(candidate => candidate.url))
    .toContain("https://vimex.test/selection")
  expect(fixture.before.transcript.marks.a?.point.itemId).toBe(fixture.targets.middle)
  expect(fixture.before.transcript.jumps.back[0]?.point.itemId).toBe(fixture.targets.first)
  expect(fixture.before.transcript.jumps.forward[0]?.point.itemId).toBe(fixture.targets.threeQuarter)
  expect(forkBoundary(fixture.before.conversation, fixture.targets.middle)).toEqual({
    threadId: fixture.threadId,
    itemId: fixture.targets.first,
    turnId: fixture.historyTurnId,
    preview: "Forkable completed user request.",
  })
})

test("scaling fixtures and repeated tail updates are reproducible", () => {
  const first = buildTranscriptScalingFixture(100)
  const second = buildTranscriptScalingFixture(100)
  expect(second.contentHash).toBe(first.contentHash)
  expect(second.targets).toEqual(first.targets)
  expect(second.before.conversation).toEqual(first.before.conversation)
  expect(second.before.transcript).toEqual(first.before.transcript)

  const firstNext = appendTranscriptScalingTail(first.afterTailDelta, first.tailItemId, first.tailDelta)
  const secondNext = appendTranscriptScalingTail(second.afterTailDelta, second.tailItemId, second.tailDelta)
  expect(secondNext).toEqual(firstNext)
})

test("oversized Markdown, command output, and split diff fixtures have stable contiguous source segments", () => {
  const fixtures = buildOversizedTranscriptFixtures()
  expect(fixtures.map(fixture => fixture.shape)).toEqual(["markdown", "command-output", "split-diff"])
  for (const fixture of fixtures) {
    expect(fixture.source.length).toBeGreaterThan(10_000)
    expect(fixture.segments.length).toBeGreaterThan(100)
    expect(fixture.segments[0]?.sourceSpan.from).toBe(0)
    expect(fixture.segments.at(-1)?.sourceSpan.to).toBe(fixture.source.length)
    expect(new Set(fixture.segments.map(segment => segment.stableId)).size).toBe(fixture.segments.length)
    for (let index = 1; index < fixture.segments.length; index++) {
      expect(fixture.segments[index]?.sourceSpan.from).toBe(fixture.segments[index - 1]?.sourceSpan.to)
    }
    for (const segment of fixture.segments) {
      expect(segment.sourceSpan.from).toBeGreaterThanOrEqual(0)
      expect(segment.sourceSpan.to).toBeGreaterThan(segment.sourceSpan.from)
      expect(segment.sourceSpan.to).toBeLessThanOrEqual(fixture.source.length)
    }
    expect(projectItem(fixture.item).source).toBe(fixture.source)
  }
  const repeated = buildOversizedTranscriptFixtures()
  expect(repeated.map(fixture => ({ shape: fixture.shape, source: fixture.source, segments: fixture.segments })))
    .toEqual(fixtures.map(fixture => ({ shape: fixture.shape, source: fixture.source, segments: fixture.segments })))
})

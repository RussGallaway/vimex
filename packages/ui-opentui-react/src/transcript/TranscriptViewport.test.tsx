import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { createConversation, itemId, reduceConversation, threadId, turnId } from "@vimex/conversation"
import { createTranscriptFrame, initialTranscript, syncTranscriptItem, type TranscriptWindow } from "@vimex/transcript"
import { act, createRef, useState } from "react"
import { createEmberTideSyntax } from "../theme"
import { sameTranscriptViewportProps, TranscriptViewport, type TranscriptViewportProps } from "./TranscriptViewport"
import { measureRenderedTranscript, transcriptBlockRenderableId } from "./rendered-layout"

test("an unrelated parent update does not reconcile a stable transcript viewport", async () => {
  const thread = threadId("memo"), turn = turnId("memo-turn"), id = itemId("memo-item")
  const item = { id, turnId: turn, kind: "assistant" as const, markdown: "Stable historical row", status: "complete" as const }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
  const transcript = syncTranscriptItem(initialTranscript(), item)
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript,
    mode: "follow",
    canonicalDamage: { kind: "full" },
  })
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  const viewportProps: TranscriptViewportProps = { window: frame.window, state: frame.transcript, surface: "transcript", syntax, scrollRef }
  let updateParent!: () => void
  function Harness() {
    const [revision, setRevision] = useState(0)
    updateParent = () => setRevision(value => value + 1)
    return <box width="100%" height="100%" flexDirection="column">
      <text>{revision}</text>
      <TranscriptViewport {...viewportProps} />
    </box>
  }
  const setup = await testRender(<Harness />, { width: 80, height: 20 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const viewport = setup.renderer.root.findDescendantById("transcript")
    await act(async () => { updateParent(); await setup.flush(); await setup.renderOnce() })
    expect(setup.renderer.root.findDescendantById("transcript")).toBe(viewport)
    expect(sameTranscriptViewportProps(viewportProps, { ...viewportProps })).toBe(true)
    expect(sameTranscriptViewportProps(viewportProps, { ...viewportProps, surface: "composer" })).toBe(false)
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("window movement mounts only planned blocks while retaining both spacer roots", async () => {
  const thread = threadId("window-mount"), turn = turnId("window-mount-turn")
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, { type: "turn.started", threadId: thread, turnId: turn })
  let transcript = initialTranscript()
  for (let index = 0; index < 3; index++) {
    const item = { id: itemId(`window-item-${index}`), turnId: turn, kind: "assistant" as const, markdown: `row ${index}`, status: "complete" as const }
    conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
    transcript = syncTranscriptItem(transcript, item)
  }
  const frame = createTranscriptFrame({ threadId: thread, canonicalGeneration: 0, canonicalRevision: 1, conversation, transcript, mode: "follow" })
  const first: TranscriptWindow = Object.freeze({ blocks: Object.freeze(frame.blocks.slice(0, 2)), topSpacerRows: 0, bottomSpacerRows: 1, overscanRows: 1 })
  const second: TranscriptWindow = Object.freeze({ blocks: Object.freeze(frame.blocks.slice(1)), topSpacerRows: 1, bottomSpacerRows: 0, overscanRows: 1 })
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  let move!: () => void
  function Harness() {
    const [window, setWindow] = useState(first)
    move = () => setWindow(second)
    return <TranscriptViewport window={window} state={frame.transcript} surface="transcript" syntax={syntax} scrollRef={scrollRef} />
  }
  const setup = await testRender(<Harness />, { width: 80, height: 20 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const top = setup.renderer.root.findDescendantById("transcript-top-spacer")
    const bottom = setup.renderer.root.findDescendantById("transcript-bottom-spacer")
    expect(top).toBeDefined()
    expect(bottom).toBeDefined()
    expect(setup.renderer.root.findDescendantById(transcriptBlockRenderableId(frame.blocks[0]!))).toBeDefined()
    expect(setup.renderer.root.findDescendantById(transcriptBlockRenderableId(frame.blocks[2]!))).toBeUndefined()

    await act(async () => { move(); await setup.flush(); await setup.renderOnce() })
    expect(setup.renderer.root.findDescendantById("transcript-top-spacer")).toBe(top)
    expect(setup.renderer.root.findDescendantById("transcript-bottom-spacer")).toBe(bottom)
    expect(top?.height).toBe(1)
    expect(bottom?.visible).toBe(false)
    expect(setup.renderer.root.findDescendantById(transcriptBlockRenderableId(frame.blocks[0]!))).toBeUndefined()
    expect(setup.renderer.root.findDescendantById(transcriptBlockRenderableId(frame.blocks[1]!))).toBeDefined()
    expect(setup.renderer.root.findDescendantById(transcriptBlockRenderableId(frame.blocks[2]!))).toBeDefined()
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("command fragments render one header, unique descendants, and no sibling or activity gaps", async () => {
  const thread = threadId("fragment-viewport"), turn = turnId("fragment-turn"), id = itemId("fragment-command")
  const detail = Array.from({ length: 180 }, (_, index) => `${String(index).padStart(4, "0")}: ${"bounded output ".repeat(5)}`).join("\n")
  const item = { id, turnId: turn, kind: "command" as const, title: "One command header", executionCommand: "bun test",
    detail, status: "complete" as const }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, { type: "turn.started", threadId: thread, turnId: turn })
  conversation = reduceConversation(conversation, { type: "item.started", threadId: thread, item })
  conversation = reduceConversation(conversation, { type: "turn.completed", threadId: thread, turnId: turn,
    outcome: "complete", durationMs: 1 })
  const transcript = syncTranscriptItem(initialTranscript(), conversation.items[id]!)
  const frame = createTranscriptFrame({ threadId: thread, canonicalGeneration: 0, canonicalRevision: 3,
    conversation, transcript, mode: "follow" })
  const itemBlocks = frame.blocks.filter(block => "projection" in block)
  expect(itemBlocks.length).toBeGreaterThan(1)
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  const setup = await testRender(<TranscriptViewport window={frame.window} state={frame.transcript}
    surface="transcript" syntax={syntax} scrollRef={scrollRef} />, { width: 80, height: 400 })
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    const captured = setup.captureCharFrame()
    expect(captured.match(/One command header/g)).toHaveLength(1)
    for (const block of itemBlocks) {
      const suffix = `:${block.key.blockId}`
      expect(setup.renderer.root.findDescendantById(`tool-output:${id}${suffix}`)).toBeDefined()
    }
    expect(setup.renderer.root.findDescendantById(`decoration:fold:${id}:command:header`)).toBeDefined()
    expect(setup.renderer.root.findDescendantById(`decoration:fold:${id}:${itemBlocks[1]!.key.blockId}`)).toBeUndefined()
    const roots = itemBlocks.map(block => setup.renderer.root.findDescendantById(transcriptBlockRenderableId(block))!)
    const outputs = itemBlocks.map(block => setup.renderer.root.findDescendantById(`tool-output:${id}:${block.key.blockId}`)!)
    for (let index = 1; index < roots.length; index++) {
      expect(roots[index]!.y).toBe(roots[index - 1]!.y + roots[index - 1]!.height)
      expect(outputs[index]!.y).toBe(outputs[index - 1]!.y + outputs[index - 1]!.height)
    }
    const activity = frame.blocks.find(block => "turn" in block)!
    const activityRoot = setup.renderer.root.findDescendantById(transcriptBlockRenderableId(activity))!
    expect(activityRoot.y).toBe(roots.at(-1)!.y + roots.at(-1)!.height)
    expect(activityRoot.y).toBe(outputs.at(-1)!.y + outputs.at(-1)!.height + 1)
    const scroll = setup.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    const layout = measureRenderedTranscript(setup.renderer, scroll, { frame, styleRevision: "command-fragment-test" })!
    const points = layout.points![id]!
    expect(Object.keys(points)).toHaveLength(frame.transcript.projectionById[id]!.source.length + 1)
    for (let index = 1; index < itemBlocks.length; index++) {
      const boundary = itemBlocks[index]!.sourceSpan.from
      expect(points[boundary]?.screenY).toBe(roots[index]!.y)
    }
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

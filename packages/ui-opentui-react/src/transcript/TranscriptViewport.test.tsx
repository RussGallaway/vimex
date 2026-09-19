import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { createConversation, itemId, reduceConversation, threadId, turnId } from "@vimex/conversation"
import { createTranscriptFrame, initialTranscript, syncTranscriptItem } from "@vimex/transcript"
import { act, createRef, useState } from "react"
import { createEmberTideSyntax } from "../theme"
import { sameTranscriptViewportProps, TranscriptViewport, type TranscriptViewportProps } from "./TranscriptViewport"

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

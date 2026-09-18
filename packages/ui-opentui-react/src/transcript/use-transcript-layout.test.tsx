import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { itemId, threadId } from "@vimex/conversation"
import { initialTranscript, reduceTranscript, syncTranscriptItem } from "@vimex/transcript"
import { assistantMessage } from "@vimex/testkit"
import { act, useRef, useState } from "react"
import { inertController } from "../contracts"
import { measuredPoint } from "./rendered-layout"
import { useTranscriptLayout } from "./use-transcript-layout"

test("reapplies a detached anchor when native geometry settles without transcript changes", async () => {
  const id = itemId("answer")
  let transcript = syncTranscriptItem(initialTranscript(), assistantMessage("answer", Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")))
  transcript = reduceTranscript(transcript, { type: "viewport.anchor", point: { itemId: id, graphemeOffset: 64 }, preferredScreenRow: 2 })
  let grow = () => {}
  let latest: ReturnType<typeof useTranscriptLayout> | undefined
  function Harness() {
    const [spacer, setSpacer] = useState(1)
    const scrollRef = useRef<ScrollBoxRenderable>(null)
    grow = () => setSpacer(6)
    latest = useTranscriptLayout({ threadId: threadId("thread"), transcript, width: 40, height: 10, scrollRef, controller: inertController })
    return <scrollbox id="scroll" ref={scrollRef} width={40} height={10}>
      <box id="native-spacer" height={spacer} flexShrink={0} />
      <box id={`transcript-item:${id}`} flexShrink={0}><text>{transcript.projectionById[id]!.plain}</text></box>
    </scrollbox>
  }
  const setup = await testRender(<Harness />, { width: 40, height: 10 })
  try {
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const scroll = setup.renderer.root.findDescendantById("scroll") as ScrollBoxRenderable
    const before = measuredPoint(latest!.measuredLayout.current!, transcript.viewport.kind === "point" ? transcript.viewport.point : undefined)!
    expect(before.screenY - scroll.viewport.screenY).toBe(2)

    await act(async () => { grow(); await setup.flush(); await setup.renderOnce() })
    for (let index = 0; index < 4; index++) await act(async () => { await setup.flush(); await setup.renderOnce() })
    const after = measuredPoint(latest!.measuredLayout.current!, transcript.viewport.kind === "point" ? transcript.viewport.point : undefined)!
    expect(after.screenY - scroll.viewport.screenY).toBe(2)
  } finally { await act(async () => setup.renderer.destroy()) }
})

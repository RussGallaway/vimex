import { expect, test } from "bun:test"
import {
  SyntaxStyle,
  type BoxRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { flushSync } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { prepareNativeTranscriptLayout } from "./scroll-preparation"

test("prepaint preparation refreshes same-frame text geometry before presenting", async () => {
  let change: (rows: number) => void = () => {}
  let box: BoxRenderable | null = null
  function Fixture() {
    const [rows, setRows] = useState(1)
    change = setRows
    return (
      <box
        ref={(value) => {
          box = value
        }}
      >
        <text>
          {Array.from({ length: rows }, (_, i) => `row ${i}`).join("\n")}
        </text>
      </box>
    )
  }
  const setup = await testRender(<Fixture />, { width: 40, height: 12 })
  const renderer = setup.renderer
  const heights: number[] = []
  const paints: string[] = []
  let pending = true
  const prepare = async () => {
    if (!pending) return
    pending = false
    for (const rows of [8, 3]) {
      flushSync(() => change(rows))
      prepareNativeTranscriptLayout(renderer)
      heights.push(box!.height)
    }
  }
  try {
    await setup.renderOnce()
    renderer.setFrameCallback(prepare)
    renderer.on("frame", () => paints.push(setup.captureCharFrame()))
    await act(async () => {
      await setup.renderOnce()
    })
    expect(heights).toEqual([8, 3])
    expect(paints.length).toBeGreaterThan(0)
    for (const paint of paints) {
      expect(paint).toContain("row 2")
      expect(paint).not.toContain("row 3")
    }
  } finally {
    renderer.removeFrameCallback(prepare)
    await act(async () => renderer.destroy())
  }
})

test("prepaint preparation refreshes Markdown and internal scrollbox geometry", async () => {
  const syntax = SyntaxStyle.create()
  let change: (rows: number) => void = () => {}
  let box: BoxRenderable | null = null
  let bottom: BoxRenderable | null = null
  let scroll: ScrollBoxRenderable | null = null
  function Fixture() {
    const [rows, setRows] = useState(3)
    change = setRows
    return (
      <scrollbox
        ref={(value) => {
          scroll = value
        }}
        height={8}
      >
        <box
          ref={(value) => {
            box = value
          }}
        >
          <markdown
            syntaxStyle={syntax}
            content={
              "```typescript\n" +
              Array.from(
                { length: rows },
                (_, i) => `const value${i} = ${i}`,
              ).join("\n") +
              "\n```"
            }
          />
        </box>
        <box
          ref={(value) => {
            bottom = value
          }}
        >
          <text>END MARKER</text>
        </box>
      </scrollbox>
    )
  }
  const setup = await testRender(<Fixture />, { width: 40, height: 12 })
  const renderer = setup.renderer
  const geometry = () => ({
    height: box!.height,
    bottom: bottom!.y,
    scrollHeight: scroll!.scrollHeight,
  })
  const prepared: ReturnType<typeof geometry>[] = []
  const tailPositions: number[] = []
  let pending = true
  const prepare = async () => {
    if (!pending) return
    pending = false
    for (const rows of [15, 3]) {
      flushSync(() => change(rows))
      prepareNativeTranscriptLayout(renderer)
      prepareNativeTranscriptLayout(renderer)
      prepared.push(geometry())
      if (rows === 15) {
        scroll!.scrollTo(8)
        prepareNativeTranscriptLayout(renderer)
        tailPositions.push(bottom!.screenY - scroll!.viewport.screenY)
        scroll!.scrollTo(0)
        prepareNativeTranscriptLayout(renderer)
        tailPositions.push(bottom!.screenY - scroll!.viewport.screenY)
      }
    }
  }
  try {
    await setup.renderOnce()
    await setup.renderOnce()
    renderer.setFrameCallback(prepare)
    await act(async () => {
      await setup.renderOnce()
    })
    renderer.removeFrameCallback(prepare)
    await setup.renderOnce()
    expect(tailPositions).toEqual([7, 15])
    expect(prepared[0]).toEqual({ height: 15, bottom: 15, scrollHeight: 16 })
    expect(prepared[1]).toEqual({ height: 3, bottom: 3, scrollHeight: 8 })
    expect(prepared[1]).toEqual(geometry())
    expect(setup.captureCharFrame()).toContain("END MARKER")
  } finally {
    renderer.removeFrameCallback(prepare)
    await act(async () => renderer.destroy())
    syntax.destroy()
  }
})

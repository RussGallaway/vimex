import { expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { LinkActionButton } from "./LinkActionButton"

test("mouse release retains the action captured on press when the rendered target changes", async () => {
  const called: string[] = []
  let update!: (value: string) => void
  function Harness() {
    const [target, setTarget] = useState("original")
    update = setTarget
    return (
      <LinkActionButton
        id="copy"
        label="Copy link"
        onActivate={() => called.push(target)}
      />
    )
  }
  const h = await testRender(<Harness />, { width: 40, height: 8 })
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const button = h.renderer.root.findDescendantById("copy") as Renderable
    await act(async () => {
      await h.mockMouse.pressDown(button.screenX + 1, button.screenY)
      update("replacement")
      await h.flush()
    })
    await act(async () => {
      await h.mockMouse.release(button.screenX + 1, button.screenY)
      await h.flush()
    })
    expect(called).toEqual(["original"])
    await act(async () => {
      await h.mockMouse.pressDown(button.screenX + 1, button.screenY)
      await h.mockMouse.moveTo(button.screenX + 3, button.screenY)
      await h.mockMouse.moveTo(button.screenX + 1, button.screenY)
      await h.mockMouse.release(button.screenX + 1, button.screenY)
      await h.flush()
    })
    expect(called).toEqual(["original"])
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

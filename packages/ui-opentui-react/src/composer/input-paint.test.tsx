import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { CliRenderer } from "@opentui/core"
import { act } from "react"
import {
  answer,
  thread,
  wheelHarness,
} from "../transcript/navigation/scroll-continuity-harness"
import {
  composerPaintPending,
  requestComposerPaint,
  subscribeComposerPaint,
} from "./input-paint"

async function startTyping(h: Awaited<ReturnType<typeof wheelHarness>>) {
  await act(async () => {
    h.controller.dispatchInteraction({ type: "focus.set", surface: "composer" })
    h.controller.dispatchInteraction({ type: "mode.insert" })
    h.controller.changeDraft("draft ", 6)
    await h.flush()
  })
}

// Assert ordering, not a runner-specific millisecond deadline: the input frame
// must paint the new character while the old transcript is still displayed.
test("streaming yields the next paint to native input and catches up without losing keys", async () => {
  const h = await wheelHarness(0)
  try {
    await startTyping(h)
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: answer,
          delta:
            "\n\n" +
            "Streaming **Markdown** with [a link](https://example.com).\n\n".repeat(
              120,
            ),
        },
      })
      await h.flush({ maxPasses: 200 })
    })
    for (let index = 0; index < 4; index++) {
      const expected = "draft " + "a".repeat(index + 1)
      const marker = `OUTPUT-AFTER-KEY-${index}`
      let inputFrame: string | undefined
      const observe = () => {
        const frame = h.captureCharFrame()
        if (
          !inputFrame &&
          composerPaintPending(h.renderer) &&
          frame.includes(expected)
        )
          inputFrame = frame
      }
      h.renderer.prependListener("frame", observe)
      try {
        await act(async () => {
          h.emit({
            type: "conversation",
            event: {
              type: "item.delta",
              threadId: thread,
              itemId: answer,
              delta: `\n\n${marker}`,
            },
          })
          h.mockInput.pressKey("a")
          await h.flush({ maxPasses: 200 })
          await h.renderOnce()
        })
        expect(inputFrame).toBeDefined()
        expect(inputFrame).not.toContain(marker)
        expect(h.workspace().composer.text).toBe(expected)
        await act(async () => {
          await Bun.sleep(5)
          h.controller.flushDraft()
          await h.flush({ maxPasses: 200 })
          await h.renderOnce()
        })
        expect(h.captureCharFrame()).toContain(marker)
      } finally {
        h.renderer.off("frame", observe)
      }
    }
  } finally {
    await act(async () => {
      await Bun.sleep(5)
      await h.flush()
    })
    await h.close()
  }
}, 30000)

test("typing then deleting before publication leaves no stale text to submit", async () => {
  const h = await wheelHarness(0)
  try {
    await startTyping(h)
    await act(async () => {
      h.controller.changeDraft("", 0)
      await h.flush()
    })
    await act(async () => {
      h.mockInput.pressKey("x")
      h.mockInput.pressKey("BACKSPACE")
      h.mockInput.pressKey("RETURN")
      await h.flush()
    })
    expect(h.workspace().composer.text).toBe("")
    expect(h.workspace().composer.outbox).toEqual([])
  } finally {
    await act(async () => {
      await Bun.sleep(5)
      await h.flush()
    })
    await h.close()
  }
})

test("submit reads the native draft before publication and preserves immediate next input", async () => {
  const h = await wheelHarness(0)
  try {
    await startTyping(h)
    await act(async () => {
      h.mockInput.pressKey("a")
      h.mockInput.pressKey("RETURN")
      h.mockInput.pressKey("b")
      await h.flush()
    })
    await h.controller.settle()
    expect(h.workspace().composer.text).toBe("b")
    expect(
      h
        .workspace()
        .composer.outbox.some((message) => message.text === "draft a"),
    ).toBe(false)
    const users = Object.values(h.workspace().conversation.items).filter(
      (item) => item.kind === "user",
    )
    // The fixture has no server echo; the submission is retained as pending.
    expect(
      h
        .workspace()
        .pendingSubmissions?.some((message) => message.text === "draft a") ||
        users.some(
          (item) => item.kind === "user" && item.markdown === "draft a",
        ),
    ).toBe(true)
  } finally {
    await act(async () => {
      await Bun.sleep(5)
      await h.flush()
    })
    await h.close()
  }
})

test("post-paint notifications do not revisit subscriptions installed during notification", async () => {
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: false,
    requestRender() {},
  }) as unknown as CliRenderer
  const calls: string[] = []
  let unsubscribe = subscribeComposerPaint(renderer, () => {
    calls.push("original")
    unsubscribe()
    unsubscribe = subscribeComposerPaint(renderer, () =>
      calls.push("replacement"),
    )
  })
  try {
    requestComposerPaint(renderer)
    renderer.emit("frame")
    await Bun.sleep(5)
    expect(calls).toEqual(["original"])
    requestComposerPaint(renderer)
    renderer.emit("frame")
    await Bun.sleep(5)
    expect(calls).toEqual(["original", "replacement"])
  } finally {
    unsubscribe()
  }
})

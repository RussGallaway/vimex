import { expect, spyOn, test } from "bun:test"
import { getTreeSitterClient, type ScrollBoxRenderable } from "@opentui/core"
import { itemId, turnId } from "@vimex/conversation"
import { blockKey } from "@vimex/transcript"
import { act } from "react"
import { subscribeNavigationTrace, type NavigationTraceRecord } from "./trace"
import { transcriptBlockRenderableId } from "../native-layout/rendered-layout"
import { thread, wheelHarness } from "./scroll-continuity-harness"

const target = itemId("readiness-linked-answer")
const tail = itemId("readiness-tail")
const marker = "Readiness fixture"
const source = Array.from(
  { length: 3 },
  () => `${marker}: [reviewing](https://vimex.test/review) older work.`,
).join("\n\n")
const tailText = Array.from(
  { length: 20 },
  (_, index) => `tail ${index} steady text`,
).join("\n")
type Harness = Awaited<ReturnType<typeof wheelHarness>>

async function frames(h: Harness, count = 4) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      await h.renderOnce()
    })
}

async function fixture(delayed: boolean) {
  const h = await wheelHarness(0)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  if (!delayed) release()
  const jobs: Promise<unknown>[] = []
  const client = getTreeSitterClient()
  const original = client.highlightOnce.bind(client)
  const highlight = spyOn(client, "highlightOnce").mockImplementation(
    (content, filetype) => {
      if (filetype !== "markdown" || !content.includes(marker))
        return original(content, filetype)
      const job = waiting.then(() => original(content, filetype))
      jobs.push(job)
      return job
    },
  )
  const trace: NavigationTraceRecord[] = []
  const unsubscribe = subscribeNavigationTrace(h.renderer, (event) =>
    trace.push(event),
  )
  let closed = false
  try {
    await act(async () => {
      for (const item of [
        {
          id: target,
          turnId: turnId("wheel-turn"),
          kind: "assistant" as const,
          markdown: source,
          status: "complete" as const,
        },
        {
          id: tail,
          turnId: turnId("wheel-turn"),
          kind: "command" as const,
          title: "Ready tail",
          detail: tailText,
          status: "complete" as const,
        },
      ])
        h.emit({
          type: "conversation",
          event: { type: "item.started", threadId: thread, item },
        })
      await h.controller.settle()
      h.controller.transcript({ type: "fold.all", folded: false })
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: tail, graphemeOffset: tailText.length - 1 },
        preferredScreenRow: 10,
        extend: false,
      })
    })
    await frames(h, 6)
    trace.length = 0
  } catch (error) {
    release()
    highlight.mockRestore()
    unsubscribe()
    await h.close()
    throw error
  }
  return {
    h,
    trace,
    jobs,
    async up() {
      await act(async () => {
        for (let i = 0; i < 4; i++) h.mockInput.pressKey("u", { ctrl: true })
      })
      await frames(h, 6)
    },
    async release() {
      release()
      await act(async () => {
        await Promise.all(jobs)
        await h.flush({ maxPasses: 300 })
      })
      await frames(h, 6)
    },
    async finishWorker() {
      release()
      await act(async () => {
        await Promise.all(jobs)
      })
    },
    async destroy() {
      await h.close()
      closed = true
    },
    async close() {
      release()
      highlight.mockRestore()
      unsubscribe()
      if (!closed) await h.close()
      await Promise.all(jobs)
    },
  }
}

function placement(h: Harness) {
  const runtime = h.controller.transcriptRuntime("main")!
  const snapshot = runtime.getSnapshot()
  const cursor = h.workspace().transcript.cursor!
  const scroll = h.renderer.root.findDescendantById(
    "transcript",
  ) as ScrollBoxRenderable
  const block = snapshot.window.blocks.find(
    (block) =>
      block.key.kind === "item" &&
      block.key.itemId === cursor.itemId &&
      snapshot.geometry.byBlockKey[blockKey(block)]?.points[
        cursor.graphemeOffset
      ],
  )!
  const point =
    snapshot.geometry.byBlockKey[blockKey(block)]!.points[
      cursor.graphemeOffset
    ]!
  const root = scroll.getRenderable(transcriptBlockRenderableId(block))!
  const x = root.screenX + point.column
  const y = root.screenY + point.row
  return {
    cursor,
    row: y - scroll.viewport.screenY,
    column: x - scroll.viewport.screenX,
    cell: h.captureCharFrame().split("\n")[y]?.[x],
  }
}

function resolved(trace: NavigationTraceRecord[]) {
  return trace.filter((event) => event.kind === "intent.resolved")
}

test("connected row intent waits for delayed Markdown and lands like ready native content", async () => {
  const ready = await fixture(false)
  let expected: ReturnType<typeof placement>
  let expectedResolutions: {
    sequence: unknown
    cursor: unknown
    nativeCursor: unknown
    coherent: unknown
  }[] = []
  try {
    await ready.up()
    await ready.release()
    expected = placement(ready.h)
    expect(expected.cursor.itemId).toBe(target)
    expect(expected.cell).toBe(
      ready.h.workspace().transcript.projectionById[target]!.plain[
        expected.cursor.graphemeOffset
      ],
    )
    expectedResolutions = resolved(ready.trace).map(({ details }) => ({
      sequence: details.sequence,
      cursor: details.cursor,
      nativeCursor: details.nativeCursor,
      coherent: details.coherent,
    }))
  } finally {
    await ready.close()
  }
  const delayed = await fixture(true)
  try {
    await delayed.up()
    expect(delayed.jobs.length).toBeGreaterThan(0)
    expect(
      delayed.trace.filter((event) => event.kind === "intent.enqueued"),
    ).toHaveLength(4)
    expect(resolved(delayed.trace).length).toBeLessThan(4)
    await delayed.release()
    expect(resolved(delayed.trace)).toHaveLength(4)
    expect(
      resolved(delayed.trace).map(({ details }) => details.sequence),
    ).toEqual(
      delayed.trace
        .filter((event) => event.kind === "intent.enqueued")
        .map(({ details }) => details.sequence),
    )
    expect(
      resolved(delayed.trace).map(({ details }) => ({
        sequence: details.sequence,
        cursor: details.cursor,
        nativeCursor: details.nativeCursor,
        coherent: details.coherent,
      })),
    ).toEqual(expectedResolutions)
    expect(placement(delayed.h)).toEqual(expected!)
  } finally {
    await delayed.close()
  }
})

test("tail jump supersedes row intent waiting for Markdown", async () => {
  const f = await fixture(true)
  try {
    await f.up()
    expect(f.jobs.length).toBeGreaterThan(0)
    await act(async () => {
      f.h.mockInput.typeText("G")
    })
    await frames(f.h, 4)
    await f.release()
    expect(f.h.workspace().transcript.viewport.kind).toBe("tail")
    expect(f.h.workspace().transcript.cursor?.itemId).toBe(tail)
  } finally {
    await f.close()
  }
})

test("destroy releases readiness observation while a real highlight is delayed", async () => {
  const f = await fixture(true)
  try {
    await f.up()
    expect(f.jobs.length).toBeGreaterThan(0)
    await f.destroy()
    const count = f.trace.length
    await f.finishWorker()
    expect(f.trace).toHaveLength(count)
  } finally {
    await f.close()
  }
})

test("idle Markdown completion refreshes the cursor origin before wheel and queued row input", async () => {
  const run = async (delayed: boolean) => {
    const f = await fixture(delayed)
    try {
      const offset = f.h
        .workspace()
        .transcript.projectionById[target]!.plain.indexOf("older")
      await act(async () => {
        f.h.controller.transcript({
          type: "cursor.move",
          target: { itemId: target, graphemeOffset: offset },
          preferredScreenRow: 4,
          extend: false,
        })
      })
      await frames(f.h, 4)
      expect(f.jobs.length).toBeGreaterThan(0)
      expect(
        f.trace.filter((event) => event.kind === "intent.enqueued"),
      ).toHaveLength(0)
      // A real worker finishes while the reader is idle. Only normal native
      // frames publish its transformed source map; no scratch render or input
      // reentrancy inside a render callback is used here.
      await f.release()
      const origin = placement(f.h)
      expect(origin.cursor).toEqual({ itemId: target, graphemeOffset: offset })
      expect(origin.cell).toBe("o")
      f.trace.length = 0
      const scroll = f.h.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      await act(async () => {
        await f.h.mockMouse.scroll(
          scroll.viewport.x + 10,
          scroll.viewport.y + 3,
          "up",
        )
        for (let i = 0; i < 2; i++) f.h.mockInput.pressKey("u", { ctrl: true })
        await f.h.flush({ maxPasses: 300 })
      })
      await frames(f.h, 6)
      expect(resolved(f.trace)).toHaveLength(2)
      return {
        origin,
        destination: placement(f.h),
        resolved: resolved(f.trace).map(({ details }) => ({
          cursor: details.cursor,
          nativeCursor: details.nativeCursor,
          coherent: details.coherent,
        })),
      }
    } finally {
      await f.close()
    }
  }
  expect(await run(true)).toEqual(await run(false))
})

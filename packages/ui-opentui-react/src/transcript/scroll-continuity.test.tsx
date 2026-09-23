import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { act } from "react"
import { blockKey, graphemes } from "@vimex/transcript"
import { transcriptBlockRenderableId } from "./rendered-layout"
import { itemId, turnId } from "@vimex/conversation"
import { wheelHarness, thread } from "./scroll-continuity-harness"

type Harness = Awaited<ReturnType<typeof wheelHarness>>

const scrollbox = (h: Harness) =>
  h.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable

function paintedTranscript(h: Harness): string[] {
  const viewport = scrollbox(h).viewport
  return (
    h
      .captureCharFrame()
      .split("\n")
      .slice(viewport.y, viewport.y + viewport.height)
      // Native scrollbar position depends on total estimated vs measured height.
      // Compare the actual content cells, including their exact row placement.
      .map((line) => line.slice(viewport.x, viewport.x + viewport.width - 1))
  )
}

async function settle(h: Harness, frames = 8) {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
}

interface Scenario {
  name: string
  navigation?: boolean
  startCommand?: number
  /** Independent native reference for mixed absolute/relative input. */
  referenceRowsFromTail?: number
  referenceHead?: boolean
  input(h: Harness): void | Promise<void>
}
const scenarios: Scenario[] = [
  {
    name: "Ctrl-U burst",
    input(h) {
      for (let i = 0; i < 8; i++) h.mockInput.pressKey("u", { ctrl: true })
    },
  },
  {
    name: "Ctrl-Y burst",
    input(h) {
      for (let i = 0; i < 56; i++) h.mockInput.pressKey("y", { ctrl: true })
    },
  },
  {
    name: "wheel burst",
    async input(h) {
      const s = scrollbox(h)
      for (let i = 0; i < 56; i++)
        await h.mockMouse.scroll(s.x + 10, s.y + 3, "up")
    },
  },
  {
    name: "previous block",
    navigation: true,
    input: (h) => h.mockInput.typeText("{"),
  },
  {
    name: "next block",
    navigation: true,
    startCommand: 97,
    input: (h) => h.mockInput.typeText("}"),
  },
  {
    name: "last item",
    navigation: true,
    startCommand: 50,
    input: (h) => h.mockInput.typeText("G"),
  },
  {
    name: "first item",
    navigation: true,
    input: (h) => h.mockInput.typeText("gg"),
  },
  {
    name: "superseded first-item jump",
    navigation: true,
    async input(h) {
      await h.mockInput.typeText("gg")
      await h.mockInput.typeText("G")
    },
  },
  {
    name: "tail jump then row up",
    navigation: true,
    startCommand: 50,
    referenceRowsFromTail: 12,
    async input(h) {
      await h.mockInput.typeText("G")
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("y", { ctrl: true })
    },
  },
  {
    name: "row up then tail jump",
    navigation: true,
    startCommand: 50,
    referenceRowsFromTail: 0,
    async input(h) {
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("y", { ctrl: true })
      await h.mockInput.typeText("G")
    },
  },
  {
    name: "first-tail-first supersession",
    navigation: true,
    startCommand: 50,
    referenceHead: true,
    async input(h) {
      await h.mockInput.typeText("gg")
      await h.mockInput.typeText("G")
      await h.mockInput.typeText("gg")
    },
  },
  {
    name: "tail boundary preserves down then up ordering",
    referenceRowsFromTail: 12,
    input(h) {
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("e", { ctrl: true })
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("y", { ctrl: true })
    },
  },
  {
    name: "up tail jump up supersedes only preceding rows",
    navigation: true,
    startCommand: 50,
    referenceRowsFromTail: 4,
    async input(h) {
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("y", { ctrl: true })
      await h.mockInput.typeText("G")
      for (let i = 0; i < 4; i++) h.mockInput.pressKey("y", { ctrl: true })
    },
  },
  {
    name: "row reversals preserve net displacement",
    referenceRowsFromTail: 18,
    input(h) {
      for (let i = 0; i < 30; i++) h.mockInput.pressKey("y", { ctrl: true })
      for (let i = 0; i < 12; i++) h.mockInput.pressKey("e", { ctrl: true })
    },
  },
  {
    name: "repeated previous blocks",
    navigation: true,
    startCommand: 50,
    async input(h) {
      for (let i = 0; i < 4; i++) await h.mockInput.typeText("{")
    },
  },
  {
    name: "counted next blocks then reverse",
    navigation: true,
    startCommand: 50,
    async input(h) {
      await h.mockInput.typeText("3}")
      await h.mockInput.typeText("{")
    },
  },
]

async function sample(expanded: boolean, dense: boolean, scenario: Scenario) {
  const h = await wheelHarness(100, expanded, dense)
  const frames: string[][] = []
  const originalEmit = h.renderer.emit
  try {
    await settle(h)
    if (scenario.navigation) {
      await act(async () => {
        h.controller.dispatchInteraction({ type: "mode.normal" })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "transcript",
        })
        h.controller.transcript({
          type: "cursor.move",
          target: {
            itemId: itemId(`scroll-command-${scenario.startCommand ?? 99}`),
            graphemeOffset: 0,
          },
          preferredScreenRow: 0,
          extend: false,
        })
      })
      await settle(h)
    }
    h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
      // FRAME fires after renderNative; listeners can already move the viewport.
      // Capture before listeners so text and position belong to the same paint.
      if (event === "frame") frames.push(paintedTranscript(h))
      return originalEmit.call(this, event, ...args)
    }
    await act(async () => {
      await scenario.input(h)
      await h.flush()
      await h.renderOnce()
    })
    await settle(h)
    if (
      dense &&
      (scenario.navigation || scenario.referenceRowsFromTail !== undefined)
    ) {
      // Dense layout is the geometry oracle, not its existing restoration hook:
      // that hook can itself fail to position gg. Place the requested semantic
      // target using fully mounted native geometry before reading expected cells.
      const frame = h.controller.transcriptRuntime("main")!.getSnapshot()
      const viewport = h.workspace().transcript.viewport
      const scroll = scrollbox(h)
      if (scenario.referenceRowsFromTail !== undefined) {
        scroll.scrollTo(
          Math.max(
            0,
            scroll.scrollHeight -
              scroll.viewport.height -
              scenario.referenceRowsFromTail,
          ),
        )
      } else if (scenario.referenceHead) scroll.scrollTo(0)
      else if (viewport.kind === "point") {
        const target = frame.blocks.find(
          (block) =>
            block.key.kind === "item" &&
            block.key.itemId === viewport.point.itemId,
        )
        if (!target) throw new Error("dense reference target missing")
        const root = scroll.getRenderable(transcriptBlockRenderableId(target))
        if (!root) throw new Error("dense reference root missing")
        const localRow =
          frame.geometry.byBlockKey[blockKey(target)]?.points[
            viewport.point.graphemeOffset
          ]?.row ?? 0
        scroll.scrollTo(
          scroll.scrollTop +
            root.screenY -
            scroll.viewport.screenY +
            localRow -
            viewport.preferredScreenRow,
        )
      } else scroll.scrollTo(scroll.scrollHeight)
      await settle(h)
    }
    return {
      frames,
      final: paintedTranscript(h),
      cursor: h.workspace().transcript.cursor,
    }
  } finally {
    h.renderer.emit = originalEmit
    await h.close()
  }
}

for (const expanded of [false, true])
  for (const scenario of scenarios)
    test(`${expanded ? "expanded" : "folded"} ${scenario.name} paints only the exact dense destination`, async () => {
      const reference = await sample(expanded, true, scenario)
      const windowed = await sample(expanded, false, scenario)
      expect(windowed.frames.length).toBeGreaterThan(0)
      expect(windowed.final).toEqual(reference.final)
      if (scenario.navigation) expect(windowed.cursor).toEqual(reference.cursor)
      for (const [index, paint] of windowed.frames.entries())
        expect(
          paint,
          `paint ${index} must already show the requested destination`,
        ).toEqual(reference.final)
    }, 30000)

async function recordPaints(h: Harness, input: () => void | Promise<void>) {
  const frames: string[][] = []
  const originalEmit = h.renderer.emit
  h.renderer.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === "frame") frames.push(paintedTranscript(h))
    return originalEmit.call(this, event, ...args)
  }
  try {
    await act(async () => {
      await input()
      await h.flush()
      await h.renderOnce()
    })
    await settle(h)
    expect(frames.length).toBeGreaterThan(0)
    return frames
  } finally {
    h.renderer.emit = originalEmit
  }
}

for (const expanded of [false, true])
  test(`${expanded ? "expanded" : "folded"} streaming tail respects detached gg, G follow, and G then row up`, async () => {
    const h = await wheelHarness(100, expanded)
    const tail = itemId("continuity-live-tail")
    const delta = (text: string) =>
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: tail,
          delta: `\n\n${text}`,
        },
      })
    try {
      await act(async () => {
        h.emit({
          type: "conversation",
          event: {
            type: "item.started",
            threadId: thread,
            item: {
              id: tail,
              turnId: turnId("wheel-turn"),
              kind: "assistant",
              status: "running",
              markdown: Array.from(
                { length: 20 },
                (_, i) => `LIVE SEED ${i}`,
              ).join("\n\n"),
            },
          },
        })
        h.controller.dispatchInteraction({ type: "mode.normal" })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "transcript",
        })
        h.controller.transcript({
          type: "cursor.move",
          target: { itemId: tail, graphemeOffset: 0 },
          preferredScreenRow: 0,
          extend: false,
        })
      })
      await settle(h)
      await recordPaints(h, () => h.mockInput.typeText("gg"))
      const head = paintedTranscript(h)
      expect(head.join("\n")).toContain("Line 0 readable output")
      await recordPaints(h, () => h.mockInput.typeText("G"))
      const detached = await recordPaints(h, async () => {
        await h.mockInput.typeText("gg")
        delta("LIVE UPDATE ONE")
      })
      expect(h.workspace().transcript.viewport.kind).toBe("point")
      for (const paint of detached) expect(paint).toEqual(head)
      const reattached = await recordPaints(h, () => h.mockInput.typeText("G"))
      expect(h.workspace().transcript.viewport.kind).toBe("tail")
      for (const paint of reattached)
        expect(paint.join("\n")).toContain("LIVE UPDATE ONE")
      const following = await recordPaints(h, () => delta("LIVE UPDATE TWO"))
      expect(h.workspace().transcript.viewport.kind).toBe("tail")
      for (const paint of following)
        expect(paint.join("\n")).toContain("LIVE UPDATE TWO")
      const detaching = await recordPaints(h, async () => {
        await h.mockInput.typeText("G")
        for (let i = 0; i < 4; i++) h.mockInput.pressKey("y", { ctrl: true })
        delta("LIVE UPDATE WHILE DETACHING")
      })
      expect(h.workspace().transcript.viewport.kind).toBe("point")
      const reading = paintedTranscript(h)
      for (const paint of detaching) expect(paint).toEqual(reading)
      const held = await recordPaints(h, () => delta("LIVE UPDATE THREE"))
      expect(h.workspace().transcript.viewport.kind).toBe("point")
      for (const paint of held) expect(paint).toEqual(reading)
    } finally {
      await h.close()
    }
  }, 30000)

test("odd-height half-page bursts preserve native per-key rounding", async () => {
  async function run(dense: boolean) {
    const h = await wheelHarness(100, false, dense)
    try {
      await act(async () => {
        h.resize(80, 25)
      })
      await settle(h)
      const scroll = scrollbox(h)
      expect(scroll.viewport.height % 2).toBe(1)
      let expectedTop = scroll.scrollTop
      for (let i = 0; i < 8; i++)
        expectedTop = Math.round(expectedTop - scroll.viewport.height / 2)
      const displacement = scroll.scrollTop - expectedTop
      return await recordPaints(h, () => {
        if (dense)
          for (let i = 0; i < displacement; i++)
            h.mockInput.pressKey("y", { ctrl: true })
        else
          for (let i = 0; i < 8; i++) h.mockInput.pressKey("u", { ctrl: true })
      })
    } finally {
      await h.close()
    }
  }
  const reference = await run(true)
  const actual = await run(false)
  for (const paint of actual) expect(paint).toEqual(reference.at(-1)!)
}, 30000)

test("expanded multi-file diffs do not spin native layout during Ctrl-U and brace navigation", async () => {
  const h = await wheelHarness(0)
  try {
    const changes = Array.from({ length: 128 }, (_, index) => {
      const path = `src/file-${index}.ts`
      return {
        path,
        action: "update" as const,
        patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new${index === 0 ? " e\u0301" : ""}`,
      }
    })
    const patch = changes.map((change) => change.patch).join("\n")
    const lastOffset = graphemes(patch).length - 1
    const edit = itemId("multi-file-edit")
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.started",
          threadId: thread,
          item: {
            id: edit,
            turnId: turnId("wheel-turn"),
            kind: "edit",
            title: "128 files changed",
            patch,
            changes,
            status: "complete",
          },
        },
      })
      await h.controller.settle()
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: edit, graphemeOffset: lastOffset },
        preferredScreenRow: 0,
        extend: false,
      })
    })
    await settle(h)
    let layoutPasses = 0
    const calculateLayout = h.renderer.root.calculateLayout.bind(
      h.renderer.root,
    )
    h.renderer.root.calculateLayout = () => {
      layoutPasses++
      return calculateLayout()
    }
    const runtime = h.controller.transcriptRuntime("main")!
    await act(async () => {
      await h.mockInput.typeText("{")
      await h.flush()
      await h.renderOnce()
    })
    expect(layoutPasses).toBeLessThan(16)
    expect(h.workspace().transcript.cursor).toEqual({
      itemId: edit,
      graphemeOffset: 0,
    })
    expect(h.captureCharFrame()).toContain("e\u0301")
    const editBlocks = runtime
      .getSnapshot()
      .window.blocks.filter(
        (block) => block.key.kind === "item" && block.key.itemId === edit,
      )
    expect(editBlocks.slice(0, 5).map((block) => block.estimatedRows)).toEqual([
      5, 3, 3, 3, 3,
    ])
    await act(async () => {
      h.controller.transcript({
        type: "cursor.move",
        target: { itemId: edit, graphemeOffset: lastOffset },
        preferredScreenRow: 0,
        extend: false,
      })
    })
    await settle(h)
    layoutPasses = 0
    await act(async () => {
      for (let index = 0; index < 8; index++)
        h.mockInput.pressKey("u", { ctrl: true })
      await h.flush()
      await h.renderOnce()
    })
    expect(layoutPasses).toBeLessThan(40)
    expect(h.workspace().transcript.cursor?.graphemeOffset).toBeLessThan(
      lastOffset,
    )
    layoutPasses = 0
    await act(async () => {
      await h.mockInput.typeText("{")
      await h.flush()
      await h.renderOnce()
    })
    expect(layoutPasses).toBeLessThan(16)
    expect(h.workspace().transcript.cursor).toEqual({
      itemId: edit,
      graphemeOffset: 0,
    })
  } finally {
    await h.close()
  }
}, 30000)

import { prepareNativeTranscriptLayout } from "../native-layout/scroll-preparation"
import { subscribeNavigationTrace } from "./trace"
import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import type { ApprovalGateway } from "@vimex/approvals"
import { itemId } from "@vimex/conversation"
import type { ConversationGateway } from "@vimex/conversation"
import { buildTranscriptNavigationFixture } from "@vimex/testkit"
import { blockKey, moveBySemanticBlock } from "@vimex/transcript"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type ThreadWorkspace,
} from "@vimex/workbench"
import { act } from "react"
import { ConnectedVimexRoot } from "../../index"
import { transcriptBlockRenderableId } from "../native-layout/rendered-layout"

async function navigationHarness(
  shape: "mixed" | "edit" | "command",
  blockCount: number,
  width: number,
  overscanRows?: number,
  foldTools = true,
) {
  const fixture = buildTranscriptNavigationFixture({ shape, blockCount })
  const summary = {
    id: fixture.threadId,
    title: "Navigation destinations",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "working" as const,
  }
  const gateway: ConversationGateway &
    ApprovalGateway &
    RuntimeConnection &
    ModelCatalog = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: () => () => {},
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    updateSettings: async () => {},
    renameThread: async () => {},
    resolveApproval: async () => {},
    listModels: async () => [],
  }
  const controller = new VimexController({
    conversation: gateway,
    approvals: gateway,
    connection: gateway,
    models: gateway,
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work", undefined, fixture.threadId)
  const state = controller.getSnapshot()
  const workspace = state.workspaces[fixture.threadId]!
  const seeded: ThreadWorkspace = Object.freeze({
    ...workspace,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: Object.freeze({
      ...fixture.before.transcript,
      selection: undefined,
      viewport: Object.freeze({ kind: "tail" as const }),
    }),
  })
  ;(state.workspaces as Record<string, ThreadWorkspace>)[fixture.threadId] =
    seeded
  const runtime = controller.transcriptRuntime("main")!
  if (overscanRows !== undefined) {
    const configure = runtime.setWindowViewport.bind(runtime)
    runtime.setWindowViewport = (rows) => configure(rows, overscanRows)
  }
  const setup = await testRender(
    <ConnectedVimexRoot controller={controller} settings={{ foldTools }} />,
    {
      width,
      height: 24,
    },
  )
  const scroll = setup.renderer.root.findDescendantById(
    "transcript",
  ) as ScrollBoxRenderable
  const settle = async () => {
    let last = ""
    let unchanged = 0
    for (let i = 0; i < 40 && unchanged < 3; i++) {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const frame = runtime.getSnapshot()
      const next = `${frame.presentationRevision}:${frame.geometry.revision}:${scroll.scrollTop}:${frame.window.blocks.length}`
      unchanged = next === last ? unchanged + 1 : 0
      last = next
    }
    expect(unchanged).toBe(3)
  }
  await settle()
  await act(async () => {
    controller.dispatchInteraction({ type: "mode.normal" })
    controller.dispatchInteraction({
      type: "focus.set",
      surface: "transcript",
    })
    controller.transcript({
      type: "cursor.move",
      target: { itemId: fixture.tailItemId, graphemeOffset: 0 },
      preferredScreenRow: 0,
      extend: false,
    })
  })
  await settle()
  const cursor = () => {
    const point =
      controller.getSnapshot().workspaces[fixture.threadId]!.transcript.cursor!
    const frame = runtime.getSnapshot()
    for (const block of frame.window.blocks) {
      if (!("item" in block) || block.key.itemId !== point.itemId) continue
      const local =
        frame.geometry.byBlockKey[blockKey(block)]?.points[point.graphemeOffset]
      const root = scroll.getRenderable(transcriptBlockRenderableId(block))
      if (local && root)
        return {
          ...point,
          row: root.screenY + local.row - scroll.viewport.screenY,
          blockId: block.key.blockId,
          localRow: local.row,
        }
    }
    throw new Error(`No native cursor geometry for ${JSON.stringify(point)}`)
  }
  const key = async (
    value: "up" | "down" | "{" | "}" | "gg" | "G",
    repeat = 1,
  ) => {
    await act(async () => {
      if (value === "up" || value === "down") {
        for (let i = 0; i < repeat; i++)
          setup.mockInput.pressKey(value === "up" ? "u" : "d", {
            ctrl: true,
          })
      } else
        await setup.mockInput.typeText(
          repeat === 1 ? value : `${repeat}${value}`,
        )
      await setup.flush()
      await setup.renderOnce()
    })
    await settle()
  }
  return {
    fixture,
    renderer: setup.renderer,
    runtime,
    scroll,
    frame: () => runtime.getSnapshot(),
    cursor,
    key,
    painted: () => setup.captureCharFrame(),
    paintedRow: (row: number) =>
      setup.captureCharFrame().split("\n")[scroll.viewport.screenY + row] ?? "",
    close: async () => {
      await act(async () => setup.renderer.destroy())
      await controller.close()
    },
  }
}

test("default folding hides oversized command output in the mounted viewport", async () => {
  const h = await navigationHarness("command", 2, 80)
  try {
    const commandId = h.fixture.before.transcript.order[0]!
    expect(h.frame().transcript.folded[commandId]).toBe(true)
    expect(
      h
        .frame()
        .window.blocks.filter(
          (block) =>
            block.key.kind === "item" && block.key.itemId === commandId,
        )
        .map(blockKey),
    ).toEqual([`item:${commandId}:root`])
    expect(h.painted()).toContain("Command output #0")
    expect(h.painted()).not.toContain("compile output")
  } finally {
    await h.close()
  }
}, 30000)

test("gg prepares native content for repeated half-page paging just like the tail", async () => {
  const h = await navigationHarness("command", 1000, 80)
  try {
    const mounted = () =>
      new Map(
        h.frame().window.blocks.map((block) => {
          const id = transcriptBlockRenderableId(block)
          const root = h.scroll.getRenderable(id)
          expect(root).toBeDefined()
          return [id, root!] as const
        }),
      )
    await h.key("G")
    const tail = mounted()
    expect(tail.size).toBeGreaterThan(250)
    for (let i = 0; i < 8; i++) {
      await h.key("up")
      for (const [id, root] of tail)
        expect(h.scroll.getRenderable(id)).toBe(root)
    }
    await h.key("gg")
    expect(h.cursor().itemId).toBe(h.fixture.before.transcript.order[0]!)
    expect(h.cursor().row).toBe(0)
    const head = mounted()
    // Both ends prepare hundreds of native roots, then retain them across the
    // same paging workload. Exact counts differ with the live tail/footer and
    // whole-block inclusion, but neither side falls back to viewport overscan.
    expect(head.size).toBeGreaterThan(250)
    const start = h.scroll.scrollTop
    for (let i = 0; i < 8; i++) {
      await h.key("down")
      for (const [id, root] of head)
        expect(h.scroll.getRenderable(id)).toBe(root)
      const cursor = h.cursor()
      expect(cursor.row).toBeGreaterThanOrEqual(0)
      expect(cursor.row).toBeLessThan(h.scroll.viewport.height)
      expect(h.paintedRow(cursor.row).trim()).not.toBe("")
    }
    expect(h.scroll.scrollTop - start).toBeGreaterThan(
      2 * h.scroll.viewport.height,
    )
  } finally {
    await h.close()
  }
}, 30000)

test("half-page scroll keeps the native cursor row through a split multi-file diff", async () => {
  const h = await navigationHarness("mixed", 30, 80)
  try {
    await h.key("up")
    await h.key("up")
    const before = h.cursor()
    expect(before.itemId).toBe(itemId("navigation-mixed-24"))
    expect(before.graphemeOffset).toBe(769)
    const source = h.frame().transcript.projectionById[before.itemId]!.plain
    expect(source.slice(before.graphemeOffset).split("\n")[0]).toBe(" }")
    // Check the source destination against painted native content rather than
    // accepting a cached point map as its own placement oracle.
    expect(h.paintedRow(before.row)).toMatch(/3\s+\}\s*$/u)
    expect(before.blockId).toBe("edit:file:556")
    expect(before.row).toBeGreaterThanOrEqual(0)
    expect(before.row).toBeLessThan(h.scroll.viewport.height)
    await h.key("up")
    const after = h.cursor()
    expect(after.itemId).toBe(before.itemId)
    expect(after.graphemeOffset).toBe(484)
    expect(source.slice(after.graphemeOffset).split("\n")[0]).toBe(
      '-  state: "before-item-24-file-1",',
    )
    expect(h.paintedRow(after.row)).toContain(
      '-   state: "before-item-24-file-1",',
    )
    expect(after.blockId).toBe("edit:file:272")
    expect(after.localRow).toBe(2)
    expect(after.row).toBe(before.row)
  } finally {
    await h.close()
  }
}, 30000)

test("queued half-page keys preserve the native cursor row within an edit", async () => {
  const h = await navigationHarness("edit", 100, 132)
  let burst: ReturnType<typeof h.cursor> | undefined
  let burstTop = 0
  try {
    await h.key("up")
    await h.key("up")
    const before = h.cursor()
    expect(before.itemId).toBe(h.fixture.before.transcript.order[97]!)
    expect(before.row).toBeGreaterThanOrEqual(0)
    expect(before.row).toBeLessThan(h.scroll.viewport.height)
    await h.key("up", 8)
    const after = h.cursor()
    expect(after.itemId).toBe(h.fixture.before.transcript.order[92]!)
    expect(after.row).toBeGreaterThanOrEqual(0)
    expect(after.row).toBeLessThan(h.scroll.viewport.height)
    expect(h.paintedRow(after.row).trim()).not.toBe("")
    burst = after
    burstTop = h.scroll.scrollTop
  } finally {
    await h.close()
  }
  const paced = await navigationHarness("edit", 100, 132)
  try {
    for (let i = 0; i < 10; i++) await paced.key("up")
    expect(paced.scroll.scrollTop).toBe(burstTop)
    expect(paced.cursor()).toMatchObject(burst!)
  } finally {
    await paced.close()
  }
}, 30000)

test("previous block reveals an offscreen command header at the upper edge", async () => {
  const h = await navigationHarness("command", 30, 80, undefined, false)
  try {
    await h.key("up")
    await h.key("up")
    await h.key("up", 8)
    for (let i = 0; i < 3; i++) await h.key("down")
    const before = h.cursor()
    expect(before.itemId).toBe(h.fixture.before.transcript.order[24]!)
    expect(before.graphemeOffset).toBeGreaterThan(8000)
    await h.key("{")
    const after = h.cursor()
    expect(after.itemId).toBe(before.itemId)
    expect(after.graphemeOffset).toBe(0)
    expect(after.blockId).toBe("command:header")
    expect(after.row).toBe(0)
  } finally {
    await h.close()
  }
}, 30000)

test("counted braces resolve cold semantic destinations before native geometry is mounted", async () => {
  const h = await navigationHarness("mixed", 400, 80)
  try {
    const before = h.frame().transcript.cursor!
    const expected = moveBySemanticBlock(
      h.frame().transcript,
      "backward",
      before,
      1000,
    )!
    expect(expected).toBeDefined()
    expect(
      h
        .frame()
        .window.blocks.some(
          (block) =>
            block.key.kind === "item" && block.key.itemId === expected.itemId,
        ),
    ).toBe(false)
    await h.key("{", 1000)
    expect(h.frame().transcript.cursor).toEqual(expected)
    const painted = h.cursor()
    expect(painted.row).toBeGreaterThanOrEqual(0)
    expect(painted.row).toBeLessThan(h.scroll.viewport.height)
    expect(h.paintedRow(painted.row).trim()).not.toBe("")
    await h.key("}", 1000)
    expect(h.frame().transcript.cursor).toEqual(before)
    const returned = h.cursor()
    expect(returned.row).toBeGreaterThanOrEqual(0)
    expect(returned.row).toBeLessThan(h.scroll.viewport.height)
  } finally {
    await h.close()
  }
}, 30000)

test("an upward key burst never jumps forward across a split diff", async () => {
  const h = await navigationHarness("mixed", 30, 80)
  try {
    for (let i = 0; i < 7; i++) await h.key("up")
    const before = h.cursor()
    await h.key("up", 8)
    const after = h.cursor()
    const order = h.fixture.before.transcript.order
    const beforeIndex = order.indexOf(before.itemId)
    const afterIndex = order.indexOf(after.itemId)
    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(afterIndex).toBeGreaterThanOrEqual(0)
    expect(
      afterIndex < beforeIndex ||
        (afterIndex === beforeIndex &&
          after.graphemeOffset <= before.graphemeOffset),
    ).toBe(true)
    expect(after.row).toBeGreaterThanOrEqual(0)
    expect(after.row).toBeLessThan(h.scroll.viewport.height)
    expect(h.paintedRow(after.row).trim()).not.toBe("")
  } finally {
    await h.close()
  }
}, 30000)

test("wide overscan cannot reverse an upward burst after window reconciliation", async () => {
  const h = await navigationHarness("mixed", 10_000, 80, 240)
  let burst: ReturnType<typeof h.cursor> | undefined
  let burstTop = 0
  try {
    for (let i = 0; i < 7; i++) await h.key("up")
    const before = h.cursor()
    expect(before.itemId).toBe(itemId("navigation-mixed-9991"))
    await h.key("up", 8)
    const after = h.cursor()
    const fragment =
      h.frame().geometry.byBlockKey["item:navigation-mixed-9991:markdown:6214"]
    expect(
      Object.keys(fragment?.pointOffsetsByRow ?? {}).length,
    ).toBeGreaterThan(0)
    const order = h.fixture.before.transcript.order
    const beforeIndex = order.indexOf(before.itemId)
    const afterIndex = order.indexOf(after.itemId)
    expect(
      afterIndex < beforeIndex ||
        (afterIndex === beforeIndex &&
          after.graphemeOffset <= before.graphemeOffset),
    ).toBe(true)
    expect(after.row).toBeGreaterThanOrEqual(0)
    expect(after.row).toBeLessThan(h.scroll.viewport.height)
    expect(h.paintedRow(after.row).trim()).not.toBe("")
    burst = after
    burstTop = h.scroll.scrollTop
  } finally {
    await h.close()
  }
  const paced = await navigationHarness("mixed", 10_000, 80, 240)
  try {
    for (let i = 0; i < 15; i++) await paced.key("up")
    const after = paced.cursor()
    expect(paced.scroll.scrollTop).toBe(burstTop)
    expect(after.itemId).toBe(burst?.itemId)
    expect(after).toMatchObject(burst!)
    expect(paced.paintedRow(after.row).trim()).not.toBe("")
  } finally {
    await paced.close()
  }
  // This compares two complete 10k-block native traces; each gets the same
  // 30-second allowance as the single-trace integration tests above.
}, 60000)

test("a cold native edge does not trap the next opposite scroll key", async () => {
  const h = await navigationHarness("mixed", 1_000, 80)
  try {
    await h.key("up")
    expect(h.frame().window.topSpacerRows).toBeGreaterThan(0)
    const priorTop = h.scroll.scrollTop
    const viewport = h.frame().transcript.viewport
    expect(viewport.kind).toBe("point")
    if (viewport.kind !== "point") throw new Error("Expected point viewport")
    const scrollBy = h.scroll.scrollBy.bind(h.scroll)
    const scrollAnchorAtRow = h.runtime.scrollAnchorAtRow.bind(h.runtime)
    try {
      // Model a native clamp while the row index can resolve only the current
      // semantic point. The key must finish even without another paint.
      h.scroll.scrollBy = () => {}
      h.runtime.scrollAnchorAtRow = () => ({
        point: viewport.point,
        preferredScreenRow: viewport.preferredScreenRow,
      })
      await h.key("up")
    } finally {
      h.scroll.scrollBy = scrollBy
      h.runtime.scrollAnchorAtRow = scrollAnchorAtRow
    }
    expect(h.scroll.scrollTop).toBe(priorTop)
    await h.key("down")
    expect(h.scroll.scrollTop).toBeGreaterThan(priorTop)
  } finally {
    await h.close()
  }
}, 30000)

test("an unmeasured row inside the same block still completes the original half-page key", async () => {
  const h = await navigationHarness("command", 400, 80, undefined, false)
  try {
    await h.key("up")
    const viewport = h.frame().transcript.viewport
    expect(viewport.kind).toBe("point")
    if (viewport.kind !== "point") throw new Error("Expected point viewport")
    const beforeTop = h.scroll.scrollTop
    const beforeCursor = h.cursor()
    const scrollBy = h.scroll.scrollBy.bind(h.scroll)
    const scrollDestinationAtRow = h.runtime.scrollDestinationAtRow.bind(
      h.runtime,
    )
    let clamped = false
    let coldLookup = false
    try {
      // The native window ends before an indexed row in the same oversized
      // command block. Its local source point is unavailable until reflow.
      h.scroll.scrollBy = (rows, behavior) => {
        if (!clamped) {
          clamped = true
          return
        }
        return scrollBy(rows, behavior)
      }
      h.runtime.scrollDestinationAtRow = (row) => {
        if (!coldLookup) {
          coldLookup = true
          return {
            point: viewport.point,
            preferredScreenRow: viewport.preferredScreenRow + 1,
            pointMeasured: false,
          }
        }
        return scrollDestinationAtRow(row)
      }
      await h.key("up")
    } finally {
      h.scroll.scrollBy = scrollBy
      h.runtime.scrollDestinationAtRow = scrollDestinationAtRow
    }
    expect(clamped).toBe(true)
    expect(coldLookup).toBe(true)
    expect(h.scroll.scrollTop).toBeLessThan(beforeTop)
    const after = h.cursor()
    expect(after.row).toBeGreaterThanOrEqual(0)
    expect(after.row).toBeLessThan(h.scroll.viewport.height)
    expect(
      after.itemId !== beforeCursor.itemId ||
        after.graphemeOffset !== beforeCursor.graphemeOffset ||
        h.scroll.scrollTop < beforeTop,
    ).toBe(true)
  } finally {
    await h.close()
  }
}, 30000)

test("half-page cursor follow is independent of native step subdivision", async () => {
  const results: Array<{ cursor: unknown; top: number; row: string }> = []
  for (const maxStep of [Infinity, 1]) {
    const h = await navigationHarness("mixed", 30, 80)
    let unsubscribe = () => {}
    try {
      let rowStepPending = false
      unsubscribe = subscribeNavigationTrace(h.renderer, (event) => {
        if (event.kind === "row.begin") rowStepPending = true
      })
      const scrollBy = h.scroll.scrollBy.bind(h.scroll)
      h.scroll.scrollBy = (delta, unit) => {
        const rowStep = rowStepPending
        rowStepPending = false
        if (rowStep && typeof delta === "number")
          return scrollBy(
            Math.sign(delta) * Math.min(Math.abs(delta), maxStep),
            unit,
          )
        return scrollBy(delta, unit)
      }
      const startTop = h.scroll.scrollTop
      const startRow = h.cursor().row
      await h.key("up")
      await h.key("up")
      const cursor = h.cursor()
      expect(h.scroll.scrollTop).toBe(
        startTop - 2 * Math.floor(h.scroll.viewport.height / 2),
      )
      expect(cursor.row).toBe(startRow)
      expect(cursor.graphemeOffset).toBe(769)
      expect(
        h
          .frame()
          .transcript.projectionById[cursor.itemId]!.plain.slice(
            cursor.graphemeOffset,
          )
          .split("\n")[0],
      ).toBe(" }")
      expect(h.paintedRow(cursor.row)).toMatch(/3\s+\}\s*$/u)
      results.push({
        cursor,
        top: h.scroll.scrollTop,
        row: h.paintedRow(cursor.row),
      })
      await h.key("down")
      await h.key("down")
      const reversed = h.cursor()
      results.push({
        cursor: reversed,
        top: h.scroll.scrollTop,
        row: h.paintedRow(reversed.row),
      })
    } finally {
      unsubscribe()
      await h.close()
    }
  }
  expect(results[2]).toEqual(results[0])
  expect(results[3]).toEqual(results[1])
}, 30000)

test("native height corrections retain an already captured scroll anchor", async () => {
  const results: unknown[] = []
  for (const addedRows of [0, 3, 9]) {
    const h = await navigationHarness("command", 2, 80, undefined, false)
    let unsubscribe = () => {}
    try {
      await h.key("up")
      const cursor = h.cursor()
      const block = h
        .frame()
        .window.blocks.find(
          (block) =>
            block.key.kind === "item" &&
            block.key.itemId === cursor.itemId &&
            block.key.blockId === cursor.blockId,
        )
      expect(block).toBeDefined()
      const root = h.scroll.getRenderable(transcriptBlockRenderableId(block!))!
      let changed = false
      let recovered = false
      unsubscribe = subscribeNavigationTrace(h.renderer, (event) => {
        if (event.kind === "anchor.capture.recover") recovered = true
        if (event.kind !== "row.step" || changed || !addedRows) return
        changed = true
        // Simulate a native reflow above the visible source cells between the
        // row movement and semantic anchor capture, without changing source.
        root.paddingTop = addedRows
        prepareNativeTranscriptLayout(h.renderer)
      })
      await h.key("up")
      const final = h.cursor()
      if (addedRows) {
        expect(changed).toBe(true)
        expect(recovered).toBe(true)
      }
      const projected = h.frame().transcript.projectionById[final.itemId]!.plain
      const sourceLine = projected.slice(final.graphemeOffset).split("\n")[0]!
      const painted = h.paintedRow(final.row)
      expect(final.graphemeOffset).toBe(10137)
      expect(final.row).toBe(10)
      expect(painted).toMatch(/0090: compile output/u)
      expect(painted).toContain(sourceLine.trim())
      results.push({
        itemId: final.itemId,
        offset: final.graphemeOffset,
        row: final.row,
        painted,
      })
    } finally {
      unsubscribe()
      await h.close()
    }
  }
  expect(results[1]).toEqual(results[0])
  expect(results[2]).toEqual(results[0])
}, 30000)

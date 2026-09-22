import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useEffect, useState } from "react"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
  type ConversationEvent,
  type ConversationItem,
} from "@vimex/conversation"
import {
  blockKey,
  initialTranscript,
  syncTranscriptItem,
  TranscriptRuntime,
  type TranscriptState,
} from "@vimex/transcript"
import { buildTranscriptScalingFixture } from "@vimex/testkit"
import { ToolCall } from "./ToolCall"
import {
  measureRenderedTranscript,
  measuredPoint,
  synchronizeRenderedTranscriptWindow,
  topVisiblePoint,
  transcriptBlockRenderableId,
  type RenderedLayoutDiagnostics,
} from "./rendered-layout"
import { movePoint, type TranscriptLayout } from "./layout"
import { createEmberTideSyntax } from "../theme"
import { TranscriptViewport } from "./TranscriptViewport"
import {
  invalidateRenderedBlock,
  takeDirtyRenderedBlocks,
} from "./measure-rendered-block"

test("native scroll translates cached points without remapping; resize invalidates geometry", async () => {
  const item = {
    id: itemId("scroll-cache"),
    turnId: turnId("turn"),
    kind: "command" as const,
    title: "Output",
    detail: Array.from(
      { length: 80 },
      (_, i) => `${i}: ${"result ".repeat(12)}`,
    ).join("\n"),
    status: "complete" as const,
  }
  const state = syncTranscriptItem(initialTranscript(), item)
  const h = await testRender(
    <scrollbox id="scroll" width="100%" height="100%">
      <box id={`transcript-item:${item.id}`}>
        <ToolCall item={item} folded={false} />
      </box>
    </scrollbox>,
    { width: 100, height: 20 },
  )
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const scroll = h.renderer.root.findDescendantById(
      "scroll",
    ) as ScrollBoxRenderable
    const initial = measureRenderedTranscript(h.renderer, scroll, state)!
    const point = { itemId: item.id, graphemeOffset: 20 }
    const initialY = measuredPoint(initial, point)!.screenY
    scroll.scrollBy(10, "step")
    await h.renderOnce()
    const moved = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(moved.points).toBe(initial.points)
    expect(measuredPoint(moved, point)!.screenY).toBe(initialY - 10)
    expect(measuredPoint(initial, point)!.screenY).toBe(initialY)
    expect(topVisiblePoint(moved, scroll)!.screenY).toBe(
      scroll.viewport.screenY,
    )
    expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(moved)
    scroll.scrollBy(-10, "step")
    await h.renderOnce()
    const restored = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(restored.points).toBe(initial.points)
    expect(measuredPoint(restored, point)!.screenY).toBe(initialY)
    h.resize(50, 20)
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(
      measureRenderedTranscript(h.renderer, scroll, state)!.points,
    ).not.toBe(initial.points)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("scrolling many settled Markdown items translates cached geometry", async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: itemId(`markdown-${index}`),
    turnId: turnId(`turn-${index}`),
    kind: "assistant" as const,
    markdown: `## Answer ${index}\n\n${"Historical **Markdown** paragraph.\n\n".repeat(5)}`,
    status: "complete" as const,
  }))
  let state = initialTranscript()
  for (const item of items) state = syncTranscriptItem(state, item)
  const syntax = createEmberTideSyntax()
  const h = await testRender(
    <scrollbox id="scroll" width="100%" height="100%">
      {items.map((item) => (
        <box id={`transcript-item:${item.id}`} key={item.id}>
          <markdown
            id={`markdown:${item.id}`}
            content={item.markdown}
            syntaxStyle={syntax}
            conceal
          />
        </box>
      ))}
    </scrollbox>,
    { width: 80, height: 20 },
  )
  try {
    for (let index = 0; index < 8; index++)
      await act(async () => {
        await h.flush()
        await h.renderOnce()
        await Bun.sleep(2)
      })
    const scroll = h.renderer.root.findDescendantById(
      "scroll",
    ) as ScrollBoxRenderable
    const initial = measureRenderedTranscript(h.renderer, scroll, state)!
    scroll.scrollBy(-7, "step")
    await h.renderOnce()
    const moved = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(moved.points).toBe(initial.points)
  } finally {
    syntax.destroy()
    await act(async () => h.renderer.destroy())
  }
})

test("cached native text avoids repeated reads and observes late equal-height reflow", async () => {
  const item = {
    id: itemId("late-text"),
    turnId: turnId("turn"),
    kind: "assistant" as const,
    markdown: "abcd",
    status: "running" as const,
  }
  const state = syncTranscriptItem(initialTranscript(), item)
  const h = await testRender(
    <scrollbox id="scroll" width={40} height={8}>
      <box id={`transcript-item:${item.id}`}>
        <text id="late-native-text">{"ab\ncd"}</text>
      </box>
    </scrollbox>,
    { width: 40, height: 8 },
  )
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const scroll = h.renderer.root.findDescendantById(
      "scroll",
    ) as ScrollBoxRenderable
    const text = h.renderer.root.findDescendantById(
      "late-native-text",
    ) as import("@opentui/core").TextRenderable
    const first = measureRenderedTranscript(h.renderer, scroll, state)!
    let reads = 0
    let prototype: object | null = text
    let getter: (() => string) | undefined
    while (prototype && !getter) {
      getter = Object.getOwnPropertyDescriptor(prototype, "plainText")?.get as
        (() => string) | undefined
      prototype = Object.getPrototypeOf(prototype)
    }
    Object.defineProperty(text, "plainText", {
      configurable: true,
      get() {
        reads++
        return getter!.call(text)
      },
    })
    for (let frame = 0; frame < 40; frame++) {
      await h.renderOnce()
      expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(first)
    }
    expect(reads).toBe(0)
    // Highlight completion may announce unchanged geometry. Preserve cache
    // identity after checking values, rather than remapping on every event.
    text.emit("line-info-change")
    expect(measureRenderedTranscript(h.renderer, scroll, state)).toBe(first)
    expect(reads).toBe(1)
    const point = { itemId: item.id, graphemeOffset: 1 }
    expect(measuredPoint(first, point)!.screenY).toBe(0)
    // This native-only update has the same dimensions and character count.
    // No transcript revision or fixed settling window may conceal its reflow.
    text.content = "a\nbcd"
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const changed = measureRenderedTranscript(h.renderer, scroll, state)!
    expect(changed.points).not.toBe(first.points)
    expect(measuredPoint(changed, point)!.screenY).toBe(1)
    expect(measuredPoint(first, point)!.screenY).toBe(0)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("transient out-of-root geometry is rejected, invalidated, and freshly accepted after settlement", async () => {
  const fixture = buildTranscriptScalingFixture(1)
  const runtime = new TranscriptRuntime(
    {
      threadId: fixture.threadId,
      canonicalGeneration: 0,
      canonicalRevision: fixture.before.canonicalRevision,
      conversation: fixture.before.conversation,
      transcript: fixture.before.transcript,
      mode: "follow",
      canonicalDamage: { kind: "full" },
    },
    { windowPolicy: { viewportRows: 8, overscanRows: 8 } },
  )
  const block = runtime
    .getSnapshot()
    .window.blocks.find((candidate) => "projection" in candidate)!
  if (!("projection" in block)) throw new Error("Expected item block")
  let setPlacement = (_settled: boolean) => {}
  function Harness() {
    const [settled, setSettled] = useState(false)
    setPlacement = setSettled
    return (
      <scrollbox id="transient-scroll" width={40} height={8}>
        <box id={transcriptBlockRenderableId(block)} height={1} flexShrink={0}>
          <text id="transient-text" position="absolute" top={settled ? 0 : 5}>
            {block.projection.plain}
          </text>
        </box>
      </scrollbox>
    )
  }
  const setup = await testRender(<Harness />, { width: 40, height: 8 })
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    takeDirtyRenderedBlocks()
    const scroll = setup.renderer.root.findDescendantById(
      "transient-scroll",
    ) as ScrollBoxRenderable
    const rejected = {
      candidateBlocks: 0,
      visibleCandidates: 0,
      overscanCandidates: 0,
      attemptedMeasurements: 0,
      changedMeasurements: 0,
      cachedMeasurements: 0,
      rejectedMeasurements: 0,
      pendingAfter: 0,
      trackedMountedRoots: 0,
      placementValidationVisits: 0,
      prunedRoots: 0,
      visibleBeforeOverscan: true,
    }
    expect(
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "transient-test",
        diagnostics: rejected,
      }),
    ).toBeUndefined()
    expect(rejected).toMatchObject({
      attemptedMeasurements: 1,
      changedMeasurements: 0,
      cachedMeasurements: 0,
      rejectedMeasurements: 1,
      pendingAfter: 1,
    })
    const root = setup.renderer.root.findDescendantById(
      transcriptBlockRenderableId(block),
    ) as Renderable
    expect(
      takeDirtyRenderedBlocks().some((entry) => entry.renderable === root),
    ).toBe(true)
    for (let attempt = 0; attempt < 4; attempt++) {
      const held = {
        ...rejected,
        attemptedMeasurements: 0,
        rejectedMeasurements: 0,
        pendingAfter: 0,
      }
      expect(
        measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(),
          runtime,
          styleRevision: "transient-test",
          diagnostics: held,
        }),
      ).toBeUndefined()
      expect(held).toMatchObject({
        attemptedMeasurements: 1,
        rejectedMeasurements: 1,
        pendingAfter: 1,
      })
    }

    await act(async () => {
      setPlacement(true)
      await setup.flush()
      await setup.renderOnce()
    })
    for (let frame = 0; frame < 3; frame++)
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
    const accepted = {
      ...rejected,
      attemptedMeasurements: 0,
      rejectedMeasurements: 0,
      pendingAfter: 0,
    }
    measureRenderedTranscript(setup.renderer, scroll, {
      frame: runtime.getSnapshot(),
      runtime,
      styleRevision: "transient-test",
      diagnostics: accepted,
    })
    const frame = runtime.getSnapshot()
    const layout = measureRenderedTranscript(setup.renderer, scroll, {
      frame,
      runtime,
      styleRevision: "transient-test",
    })!
    expect(accepted).toMatchObject({
      attemptedMeasurements: 1,
      changedMeasurements: 1,
      cachedMeasurements: 0,
      rejectedMeasurements: 0,
      pendingAfter: 1,
    })
    expect(frame.geometry.measuredBlockCount).toBe(1)
    expect(
      Object.values(frame.geometry.byBlockKey)[0]?.rows,
    ).toBeLessThanOrEqual(root.height)
    expect(layout.materializedBlocks).toBe(frame.window.blocks)

    await act(async () => {
      setPlacement(false)
      await setup.flush()
      await setup.renderOnce()
    })
    for (let frame = 0; frame < 3; frame++)
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
    invalidateRenderedBlock(root)
    let terminal = accepted
    let reachedRetryLimit = false
    for (let attempt = 0; attempt < 10; attempt++) {
      terminal = {
        ...rejected,
        attemptedMeasurements: 0,
        rejectedMeasurements: 0,
        pendingAfter: 0,
      }
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "transient-test",
        diagnostics: terminal,
      })
      if (terminal.rejectedMeasurements === 1 && terminal.pendingAfter === 0)
        reachedRetryLimit = true
    }
    expect(reachedRetryLimit).toBe(true)
    expect(terminal).toMatchObject({
      attemptedMeasurements: 0,
      pendingAfter: 0,
    })
  } finally {
    runtime.dispose()
    await act(async () => setup.renderer.destroy())
  }
})

test("a block-damage append is discovered after an initially empty render plan", async () => {
  const thread = threadId("append-thread")
  const turn = turnId("append-turn")
  const item = {
    id: itemId("appended"),
    turnId: turn,
    kind: "assistant" as const,
    markdown: "new answer",
    status: "running" as const,
  }
  let conversation = createConversation(thread)
  let transcript = initialTranscript()
  let revision = 0
  const runtime = new TranscriptRuntime({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: revision,
    conversation,
    transcript,
    mode: "follow",
    canonicalDamage: { kind: "none" },
  })
  let mount = () => {}
  function Harness() {
    const [visible, setVisible] = useState(false)
    mount = () => setVisible(true)
    return (
      <scrollbox id="scroll" width={40} height={8}>
        {visible ? (
          <box id={`transcript-block:${item.id}:root`} width={40} height={1}>
            <text>{item.markdown}</text>
          </box>
        ) : null}
      </scrollbox>
    )
  }
  const h = await testRender(<Harness />, { width: 40, height: 8 })
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const scroll = h.renderer.root.findDescendantById(
      "scroll",
    ) as ScrollBoxRenderable
    expect(
      measureRenderedTranscript(h.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "test",
      }),
    ).toBeUndefined()

    conversation = reduceConversation(conversation, {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
    })
    revision++
    conversation = reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item,
    })
    revision++
    transcript = syncTranscriptItem(transcript, conversation.items[item.id]!)
    const appended = runtime.update({
      threadId: thread,
      canonicalGeneration: 0,
      canonicalRevision: revision,
      conversation,
      transcript,
      mode: "follow",
      canonicalDamage: { kind: "blocks", itemIds: [item.id] },
    })
    await act(async () => {
      mount()
      await h.flush()
      await h.renderOnce()
      await h.renderOnce()
    })
    expect(
      measureRenderedTranscript(h.renderer, scroll, {
        frame: appended,
        runtime,
        styleRevision: "test",
      }),
    ).toBeUndefined()
    const measured = runtime.getSnapshot()
    expect(Object.keys(measured.geometry.byBlockKey)).toEqual([
      `item:${item.id}:root`,
    ])
    expect(
      measured.geometry.byBlockKey[`item:${item.id}:root`]?.key.contentRevision,
    ).toBe(appended.blocks[0]?.contentRevision)
    expect(measured.geometry.totalPoints).toBeGreaterThan(0)
    expect(
      measureRenderedTranscript(h.renderer, scroll, {
        frame: measured,
        runtime,
        styleRevision: "test",
      }),
    ).toBeDefined()
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("incremental block geometry and navigation equal a fresh full measurement", async () => {
  const thread = threadId("geometry-equivalence"),
    turn = turnId("geometry-equivalence-turn")
  const first = itemId("geometry-first"),
    growing = itemId("geometry-growing"),
    last = itemId("geometry-last")
  type Source = {
    conversation: ReturnType<typeof createConversation>
    transcript: TranscriptState
    revision: number
  }
  const apply = (source: Source, event: ConversationEvent): Source => {
    const conversation = reduceConversation(source.conversation, event)
    const changed =
      event.type === "item.delta"
        ? event.itemId
        : event.type === "item.started" || event.type === "item.completed"
          ? event.item.id
          : undefined
    const transcript =
      changed && conversation.items[changed]
        ? syncTranscriptItem(source.transcript, conversation.items[changed]!)
        : source.transcript
    return {
      conversation,
      transcript,
      revision:
        source.revision + (conversation === source.conversation ? 0 : 1),
    }
  }
  let source: Source = {
    conversation: createConversation(thread),
    transcript: initialTranscript(),
    revision: 0,
  }
  source = apply(source, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  const items: ConversationItem[] = [
    {
      id: first,
      turnId: turn,
      kind: "command",
      title: "First",
      detail: "first row\nsecond row",
      status: "complete",
    },
    {
      id: growing,
      turnId: turn,
      kind: "command",
      title: "Growing",
      detail: "seed",
      status: "running",
    },
    {
      id: last,
      turnId: turn,
      kind: "command",
      title: "Last",
      detail: "last row\nlast second row",
      status: "complete",
    },
  ]
  for (const item of items)
    source = apply(source, { type: "item.started", threadId: thread, item })
  const runtimeInput = (value: Source) => ({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: value.revision,
    conversation: value.conversation,
    transcript: value.transcript,
    mode: "follow" as const,
  })
  const renderBlocks = (runtime: TranscriptRuntime) =>
    runtime.getSnapshot().window.blocks.flatMap((block) => {
      if (
        !("item" in block) ||
        (block.renderItem.kind !== "command" &&
          block.renderItem.kind !== "tool")
      )
        return []
      return [
        <box
          key={blockKey(block)}
          id={transcriptBlockRenderableId(block)}
          flexShrink={0}
        >
          <ToolCall item={block.renderItem} folded={false} />
        </box>,
      ]
    })
  const measure = (
    runtime: TranscriptRuntime,
    renderer: Awaited<ReturnType<typeof testRender>>["renderer"],
    scroll: ScrollBoxRenderable,
  ): TranscriptLayout => {
    measureRenderedTranscript(renderer, scroll, {
      frame: runtime.getSnapshot(),
      runtime,
      styleRevision: "equivalence",
    })
    const frame = runtime.getSnapshot()
    const layout = measureRenderedTranscript(renderer, scroll, {
      frame,
      runtime,
      styleRevision: "equivalence",
    })
    expect(layout?.geometry).toBe(frame.geometry)
    expect(frame.geometry.measuredBlockCount).toBe(3)
    return layout!
  }
  const normalized = (runtime: TranscriptRuntime, layout: TranscriptLayout) => {
    const frame = runtime.getSnapshot()
    const origin = layout.placementByBlockKey?.[blockKey(frame.blocks[0]!)] ?? {
      screenX: 0,
      screenY: 0,
    }
    const blocks = frame.blocks.map((block) => {
      const key = blockKey(block),
        geometry = frame.geometry.byBlockKey[key]!
      const placement = layout.placementByBlockKey?.[key] ?? origin
      return {
        key: geometry.key,
        rows: geometry.rows,
        points: Object.values(geometry.points)
          .sort((left, right) => left.graphemeOffset - right.graphemeOffset)
          .map(({ graphemeOffset, x, y, row, column, hidden }) => ({
            graphemeOffset,
            x,
            y,
            row,
            column,
            hidden: Boolean(hidden),
          })),
        lines: geometry.lines,
        placement: {
          x: placement.screenX - origin.screenX,
          y: placement.screenY - origin.screenY,
        },
      }
    })
    const points = frame.transcript.order.flatMap((id) =>
      Array.from(
        {
          length:
            (frame.transcript.projectionById[id]?.sourceSpans.length ?? 0) + 1,
        },
        (_, graphemeOffset) => {
          const point = measuredPoint(layout, { itemId: id, graphemeOffset })
          expect(point).toBeDefined()
          return {
            itemId: id,
            graphemeOffset,
            row: point!.row,
            column: point!.column,
            hidden: Boolean(point!.hidden),
            x: point!.screenX - origin.screenX,
            y: point!.screenY - origin.screenY,
          }
        },
      ),
    )
    const motions = [
      "left",
      "right",
      "up",
      "down",
      "line-start",
      "line-end",
      "first",
      "last",
    ] as const
    const navigation = frame.transcript.order
      .flatMap((id) =>
        Array.from(
          {
            length:
              (frame.transcript.projectionById[id]?.sourceSpans.length ?? 0) +
              1,
          },
          (_, graphemeOffset) =>
            motions.map((motion) => {
              const result = movePoint(
                layout,
                { itemId: id, graphemeOffset },
                motion,
              )
              expect(result).toBeDefined()
              return { itemId: id, graphemeOffset, motion, result }
            }),
        ),
      )
      .flat()
    return {
      geometry: {
        width: frame.geometry.width,
        styleRevision: frame.geometry.styleRevision,
        totalRows: frame.geometry.totalRows,
        measuredBlockCount: frame.geometry.measuredBlockCount,
        totalPoints: frame.geometry.totalPoints,
        blockRows: frame.geometry.blockRows,
        rowByBlockKey: frame.geometry.rowByBlockKey,
      },
      blocks,
      points,
      navigation,
      edges: motions.slice(-2).map((motion) => ({
        motion,
        result: movePoint(layout, undefined, motion),
      })),
    }
  }

  const incremental = new TranscriptRuntime(runtimeInput(source))
  const incrementalRender = await testRender(
    <scrollbox id="incremental-scroll" width={42} height={12}>
      {renderBlocks(incremental)}
    </scrollbox>,
    { width: 42, height: 12 },
  )
  let fullRender: Awaited<ReturnType<typeof testRender>> | undefined
  let incrementalDestroyed = false
  try {
    await act(async () => {
      await incrementalRender.flush()
      await incrementalRender.renderOnce()
    })
    const incrementalScroll =
      incrementalRender.renderer.root.findDescendantById(
        "incremental-scroll",
      ) as ScrollBoxRenderable
    const initialLayout = measure(
      incremental,
      incrementalRender.renderer,
      incrementalScroll,
    )
    const before = incremental.getSnapshot()
    const firstKey = `item:${first}:root`,
      growingKey = `item:${growing}:root`,
      lastKey = `item:${last}:root`
    const firstGeometry = before.geometry.byBlockKey[firstKey],
      lastGeometry = before.geometry.byBlockKey[lastKey]
    const lastStart = before.geometry.rowByBlockKey[lastKey]

    source = apply(source, {
      type: "item.delta",
      threadId: thread,
      itemId: growing,
      delta:
        "\n" +
        Array.from(
          { length: 20 },
          (_, index) => `growing row ${index} ${"wrapped ".repeat(8)}`,
        ).join("\n"),
    })
    const damaged = incremental.update({
      ...runtimeInput(source),
      canonicalDamage: { kind: "blocks", itemIds: [growing] },
    })
    expect(
      source.conversation.items[growing]?.kind === "command"
        ? source.conversation.items[growing].detail
        : "",
    ).toContain("growing row 19")
    const damagedGrowing = damaged.blocks.find(
      (block) => block.key.kind === "item" && block.key.itemId === growing,
    )
    expect(
      damagedGrowing &&
        "renderItem" in damagedGrowing &&
        damagedGrowing.renderItem.kind === "command"
        ? damagedGrowing.renderItem.detail
        : "",
    ).toContain("growing row 19")
    expect(damaged.geometry.byBlockKey[firstKey]).toBe(firstGeometry)
    expect(damaged.geometry.byBlockKey[lastKey]).toBe(lastGeometry)
    expect(damaged.geometry.byBlockKey[growingKey]).toBeUndefined()
    // Update the native leaf directly to isolate reflow/measurement from React
    // reconciliation after the runtime has invalidated only the changed block.
    const growingOutput = incrementalRender.renderer.root.findDescendantById(
      `tool-output:${growing}`,
    ) as import("@opentui/core").TextRenderable
    growingOutput.content =
      source.conversation.items[growing]!.kind === "command"
        ? source.conversation.items[growing]!.detail
        : ""
    await act(async () => {
      await incrementalRender.flush()
      await incrementalRender.renderOnce()
      await incrementalRender.renderOnce()
    })
    const incrementalLayout = measure(
      incremental,
      incrementalRender.renderer,
      incrementalScroll,
    )
    expect(incremental.getSnapshot().geometry.byBlockKey[firstKey]).toBe(
      firstGeometry,
    )
    expect(incremental.getSnapshot().geometry.byBlockKey[lastKey]).toBe(
      lastGeometry,
    )
    expect(
      incremental.getSnapshot().geometry.byBlockKey[growingKey]!.rows,
    ).toBeGreaterThan(before.geometry.byBlockKey[growingKey]!.rows)
    expect(
      incremental.getSnapshot().geometry.rowByBlockKey[lastKey],
    ).toBeGreaterThan(lastStart!)
    expect(
      measuredPoint(initialLayout, { itemId: last, graphemeOffset: 0 })?.row,
    ).not.toBe(
      measuredPoint(incrementalLayout, { itemId: last, graphemeOffset: 0 })
        ?.row,
    )
    const incrementalResult = normalized(incremental, incrementalLayout)
    await act(async () => incrementalRender.renderer.destroy())
    incrementalDestroyed = true

    const full = new TranscriptRuntime(runtimeInput(source))
    fullRender = await testRender(
      <scrollbox id="full-scroll" width={42} height={12}>
        {renderBlocks(full)}
      </scrollbox>,
      { width: 42, height: 12 },
    )
    await act(async () => {
      await fullRender!.flush()
      await fullRender!.renderOnce()
      await fullRender!.renderOnce()
    })
    const fullScroll = fullRender.renderer.root.findDescendantById(
      "full-scroll",
    ) as ScrollBoxRenderable
    const fullLayout = measure(full, fullRender.renderer, fullScroll)
    expect(incrementalResult).toEqual(normalized(full, fullLayout))
  } finally {
    if (fullRender) await act(async () => fullRender!.renderer.destroy())
    if (!incrementalDestroyed)
      await act(async () => incrementalRender.renderer.destroy())
  }
})

test("window movement measures visible roots first and releases every departed scheduler root", async () => {
  const fixture = buildTranscriptScalingFixture(100)
  const input = (
    transcript = fixture.before.transcript,
    mode: "follow" | "detached" = "follow",
  ) => ({
    threadId: fixture.threadId,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript,
    mode,
    canonicalDamage: { kind: "full" as const },
    presentationDamage: { kind: "view" as const },
  })
  const runtime = new TranscriptRuntime(input(), {
    windowPolicy: { viewportRows: 8, overscanRows: 8 },
  })
  const syntax = createEmberTideSyntax()
  let shift!: () => void
  function Harness() {
    const [frame, setFrame] = useState(runtime.getSnapshot())
    useEffect(
      () => runtime.subscribe(() => setFrame(runtime.getSnapshot())),
      [],
    )
    shift = () => {
      const target = { itemId: fixture.targets.quarter, graphemeOffset: 0 }
      const transcript = Object.freeze({
        ...fixture.before.transcript,
        cursor: target,
        viewport: Object.freeze({
          kind: "point" as const,
          point: target,
          preferredScreenRow: 2,
        }),
      })
      setFrame(runtime.update(input(transcript, "detached")))
    }
    return (
      <TranscriptViewport
        window={frame.window}
        state={frame.transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={{ current: null }}
      />
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 12 })
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const scroll = setup.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    const initialDiagnostics = {
      attemptedKeys: [],
    } as unknown as RenderedLayoutDiagnostics
    await act(async () => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "window-test",
        diagnostics: initialDiagnostics,
      })
      await setup.flush()
      await setup.renderOnce()
    })
    expect(initialDiagnostics.candidateBlocks).toBe(16)
    expect(initialDiagnostics.attemptedMeasurements).toBe(16)
    expect(initialDiagnostics.trackedMountedRoots).toBe(16)
    expect(initialDiagnostics.visibleBeforeOverscan).toBe(true)
    measureRenderedTranscript(setup.renderer, scroll, {
      frame: runtime.getSnapshot(),
      runtime,
      styleRevision: "window-test",
    })
    const beforeShift = runtime.getSnapshot()

    await act(async () => {
      shift()
      await setup.flush()
      await setup.renderOnce()
    })
    const shifted = runtime.getSnapshot()
    expect(shifted.window.blocks).toHaveLength(24)
    const cleanupDiagnostics = {
      prunedRoots: 0,
      pendingAfter: 0,
      trackedMountedRoots: 0,
    } as RenderedLayoutDiagnostics
    synchronizeRenderedTranscriptWindow(scroll, shifted, cleanupDiagnostics)
    const shiftedKeys = new Set(shifted.window.blocks.map(blockKey))
    const expectedDeparted = beforeShift.window.blocks.filter(
      (block) => !shiftedKeys.has(blockKey(block)),
    ).length
    expect(cleanupDiagnostics.prunedRoots).toBe(expectedDeparted)
    expect(cleanupDiagnostics.trackedMountedRoots).toBe(0)
    expect(cleanupDiagnostics.pendingAfter).toBe(24)
    const shiftDiagnostics = {
      attemptedKeys: [],
    } as unknown as RenderedLayoutDiagnostics
    await act(async () => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: shifted,
        runtime,
        styleRevision: "window-test",
        diagnostics: shiftDiagnostics,
      })
      await setup.flush()
      await setup.renderOnce()
    })
    expect(shiftDiagnostics.candidateBlocks).toBeLessThanOrEqual(24)
    expect(shiftDiagnostics.attemptedMeasurements).toBeLessThanOrEqual(24)
    expect(shiftDiagnostics.trackedMountedRoots).toBe(24)
    expect(shiftDiagnostics.prunedRoots).toBe(0)
    expect(shiftDiagnostics.visibleBeforeOverscan).toBe(true)
    expect(
      shiftDiagnostics.attemptedKeys!.every((key) =>
        shifted.window.blocks.some((block) => blockKey(block) === key),
      ),
    ).toBe(true)
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("a drop-only window change cannot reuse native placements from the wider materialization", async () => {
  const fixture = buildTranscriptScalingFixture(100)
  const input = {
    threadId: fixture.threadId,
    canonicalGeneration: 0,
    canonicalRevision: fixture.before.canonicalRevision,
    conversation: fixture.before.conversation,
    transcript: fixture.before.transcript,
    mode: "follow" as const,
    canonicalDamage: { kind: "full" as const },
  }
  const runtime = new TranscriptRuntime(input, {
    windowPolicy: { viewportRows: 8, overscanRows: 8 },
  })
  const syntax = createEmberTideSyntax()
  let shrink!: () => void
  function Harness() {
    const [frame, setFrame] = useState(runtime.getSnapshot())
    shrink = () => setFrame(runtime.setWindowViewport(4, 4))
    return (
      <TranscriptViewport
        window={frame.window}
        state={frame.transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={{ current: null }}
      />
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 12 })
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const scroll = setup.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    await act(async () => {
      measureRenderedTranscript(setup.renderer, scroll, {
        frame: runtime.getSnapshot(),
        runtime,
        styleRevision: "cache-window-test",
      })
      await setup.flush()
      await setup.renderOnce()
    })
    const measured = runtime.getSnapshot()
    const wider = measureRenderedTranscript(setup.renderer, scroll, {
      frame: measured,
      runtime,
      styleRevision: "cache-window-test",
    })!
    const departed = blockKey(measured.window.blocks[0]!)
    expect(wider.placementByBlockKey?.[departed]).toBeDefined()

    await act(async () => {
      shrink()
      await setup.flush()
      await setup.renderOnce()
    })
    const narrowed = runtime.getSnapshot()
    expect(narrowed.geometry).not.toBe(measured.geometry)
    expect(narrowed.geometry.blockRows).toHaveLength(
      narrowed.window.blocks.length,
    )
    expect(
      Object.keys(narrowed.geometry.byBlockKey).length,
    ).toBeLessThanOrEqual(narrowed.window.blocks.length)
    const layout = measureRenderedTranscript(setup.renderer, scroll, {
      frame: narrowed,
      runtime,
      styleRevision: "cache-window-test",
    })!
    expect(layout).not.toBe(wider)
    expect(layout.materializedBlocks).toBe(narrowed.window.blocks)
    expect(layout.placementByBlockKey?.[departed]).toBeUndefined()
    expect(
      layout.screenBlockRows?.some((row) => row.blockKey === departed),
    ).toBe(false)
    expect(
      Object.values(layout.blockKeysByItem ?? {})
        .flat()
        .some((ref) => ref.blockKey === departed),
    ).toBe(false)
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

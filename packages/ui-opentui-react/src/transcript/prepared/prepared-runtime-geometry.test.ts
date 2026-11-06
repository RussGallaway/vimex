import { expect, test } from "bun:test"
import { createElement, act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { itemId, threadId, turnId } from "@vimex/conversation"
import {
  initialTranscript,
  projectPlainText,
  type TranscriptFrame,
  type TranscriptItemBlock,
} from "@vimex/transcript"
import {
  PreparedRuntimeGeometryBridge,
  type PreparedRuntimeGeometryScheduler,
} from "./prepared-runtime-geometry"
import type { MeasureRenderedBlockInput } from "../native-layout/measure-rendered-block"

class Tasks implements PreparedRuntimeGeometryScheduler {
  tasks = new Map<object, () => void>()
  schedule(task: () => void) {
    const token = {}
    this.tasks.set(token, task)
    return token
  }
  cancel(token: unknown) {
    this.tasks.delete(token as object)
  }
  next() {
    const next = this.tasks.entries().next().value
    if (next) {
      this.tasks.delete(next[0])
      next[1]()
    }
  }
}

async function fixture(
  text = "hello world",
  viewport?: () => { screenY: number; height: number },
) {
  const id = itemId("command")
  const item = {
    id,
    turnId: turnId("turn"),
    kind: "command" as const,
    title: "command",
    detail: text,
    status: "complete" as const,
  }
  const block: TranscriptItemBlock = {
    key: { kind: "item", itemId: id, blockId: "output-1" },
    turnId: item.turnId,
    item,
    renderItem: item,
    projection: { ...projectPlainText(text), revision: 1 },
    sourceSpan: { from: 0, to: text.length },
    contentRevision: 1,
    estimatedRows: 1,
    fragment: { kind: "command-output", index: 1, count: 2 },
    followedByActivity: false,
  }
  const frame = {
    threadId: threadId("thread"),
    canonicalGeneration: 1,
    geometry: { generation: 1 },
    window: { blocks: [block], activityPresentation: {} },
    transcript: initialTranscript(),
  } as unknown as TranscriptFrame
  const setup = await testRender(
    createElement(
      "box",
      { id: "root", paddingLeft: 3 },
      createElement("text", {
        id: "tool-output:command:output-1",
        content: text,
        width: 24,
        wrapMode: "word",
      }),
    ),
    { width: 40, height: 12 },
  )
  await act(async () => {
    await setup.flush()
    await setup.renderOnce()
  })
  const root = setup.renderer.root.findDescendantById("root")!
  const body = root.findDescendantById(
    "tool-output:command:output-1",
  ) as TextRenderable
  const tasks = new Tasks()
  const bridge = new PreparedRuntimeGeometryBridge(setup.renderer, tasks, {
    viewport,
  })
  bridge.begin(frame, "test")
  const input: MeasureRenderedBlockInput = {
    renderer: setup.renderer,
    renderable: root,
    block,
    width: 40,
    styleRevision: "test",
    folded: false,
  }
  const close = async () => {
    bridge.dispose()
    await act(async () => setup.renderer.destroy())
  }
  return { text, block, frame, setup, root, body, tasks, bridge, input, close }
}

test("cold lookup queues one bounded future job and a warm hit has native placement", async () => {
  const f = await fixture()
  try {
    expect(f.bridge.points(f.input, f.text)).toBeUndefined()
    expect(f.bridge.points(f.input, f.text)).toBeUndefined()
    expect(f.bridge.diagnostics.queued).toBe(1)
    expect(f.bridge.diagnostics.prepared).toBe(0)
    expect(f.tasks.tasks.size).toBe(1)
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(1)
    expect(f.tasks.tasks.size).toBe(0)
    const points = f.bridge.points(f.input, f.text)!
    expect(points[0]).toEqual({ graphemeOffset: 0, x: f.body.x, y: f.body.y })
    expect(points[f.text.length]?.x).toBe(f.body.x + f.text.length)
    expect(f.bridge.diagnostics.hits).toBe(1)
  } finally {
    await f.close()
  }
})

test("scope changes cancel queued work and clear ready geometry", async () => {
  const f = await fixture()
  try {
    for (const changed of [
      { ...f.frame, threadId: threadId("next") },
      { ...f.frame, canonicalGeneration: 2 },
      { ...f.frame, geometry: { ...f.frame.geometry, generation: 2 } },
    ]) {
      f.bridge.begin(f.frame, "test")
      f.bridge.points(f.input, f.text)
      f.bridge.synchronize(changed)
      expect(f.tasks.tasks.size).toBe(0)
      expect(f.bridge.diagnostics.cache.entries).toBe(0)
    }
    f.bridge.begin(f.frame, "test")
    f.bridge.points(f.input, f.text)
    f.tasks.next()
    expect(f.bridge.diagnostics.cache.entries).toBe(1)
    f.bridge.begin(f.frame, "new-style")
    expect(f.bridge.diagnostics.cache.entries).toBe(0)
    expect(f.bridge.points(f.input, f.text)).toBeUndefined()
  } finally {
    await f.close()
  }
})

test("departed or changed window blocks cannot complete stale preparation", async () => {
  const f = await fixture()
  try {
    f.bridge.points(f.input, f.text)
    f.bridge.synchronize({
      ...f.frame,
      window: { ...f.frame.window, blocks: [] },
    })
    expect(f.tasks.tasks.size).toBe(0)
    expect(f.bridge.diagnostics.stale).toBe(1)
    f.bridge.begin(f.frame, "test")
    f.bridge.points(f.input, f.text)
    const replacement = { ...f.block, contentRevision: 2 }
    f.bridge.synchronize({
      ...f.frame,
      window: { ...f.frame.window, blocks: [replacement] },
    })
    expect(f.tasks.tasks.size).toBe(0)
    expect(f.bridge.diagnostics.prepared).toBe(0)
  } finally {
    await f.close()
  }
})

test("same root width or text changes reject queued jobs at completion", async () => {
  const f = await fixture()
  try {
    f.bridge.points(f.input, f.text)
    f.body.width = 20
    await act(async () => {
      await f.setup.flush()
      await f.setup.renderOnce()
    })
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(0)
    expect(f.bridge.diagnostics.stale).toBe(1)
    f.bridge.points(f.input, f.text)
    f.body.content = "changed"
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(0)
    expect(f.bridge.diagnostics.stale).toBe(2)
  } finally {
    await f.close()
  }
})

test("folded, running, non-final, transformed and oversized inputs use native fallback", async () => {
  const f = await fixture()
  try {
    const cases = [
      { ...f.input, folded: true },
      {
        ...f.input,
        block: {
          ...f.block,
          renderItem: { ...f.block.renderItem, status: "running" as const },
        },
      },
      {
        ...f.input,
        block: {
          ...f.block,
          fragment: { kind: "command-output" as const, index: 0, count: 2 },
        },
      },
      {
        ...f.input,
        block: {
          ...f.block,
          projection: { ...f.block.projection, source: "**transformed**" },
        },
      },
    ]
    for (const input of cases) {
      f.bridge.begin(
        { ...f.frame, window: { ...f.frame.window, blocks: [input.block] } },
        "test",
      )
      expect(f.bridge.points(input, f.text)).toBeUndefined()
    }
    f.bridge.begin(f.frame, "test")
    for (const text of ["changed", "a\tb", "x".repeat(4097), "\x1b[31mred"])
      expect(f.bridge.points(f.input, text)).toBeUndefined()
    expect(f.bridge.diagnostics.queued).toBe(0)
  } finally {
    await f.close()
  }
})

test("unsupported native preparation is not retried indefinitely", async () => {
  const f = await fixture("\u0301")
  try {
    f.bridge.points(f.input, f.text)
    f.tasks.next()
    expect(f.bridge.diagnostics.failed).toBe(1)
    for (let i = 0; i < 20; i++)
      expect(f.bridge.points(f.input, f.text)).toBeUndefined()
    expect(f.bridge.diagnostics.queued).toBe(1)
    expect(f.tasks.tasks.size).toBe(0)
  } finally {
    await f.close()
  }
})

test("dispose cancels preparation and prevents new work", async () => {
  const f = await fixture()
  try {
    f.bridge.points(f.input, f.text)
    f.bridge.dispose()
    expect(f.tasks.tasks.size).toBe(0)
    expect(f.bridge.points(f.input, f.text)).toBeUndefined()
    f.bridge.begin(f.frame, "test")
    expect(f.bridge.points(f.input, f.text)).toBeUndefined()
    expect(f.bridge.diagnostics.cache.entries).toBe(0)
  } finally {
    await f.close()
  }
})

test("preparation admission is bounded and each scheduled turn prepares one block", async () => {
  const f = await fixture()
  try {
    const blocks = [f.block]
    const inputs = [f.input]
    for (let index = 2; index <= 20; index++) {
      const block: TranscriptItemBlock = {
        ...f.block,
        key: { ...f.block.key, blockId: `output-${index}` },
      }
      const root = new BoxRenderable(f.setup.renderer, { id: `root-${index}` })
      const body = new TextRenderable(f.setup.renderer, {
        id: `tool-output:command:output-${index}`,
        content: f.text,
        width: 24,
        wrapMode: "word",
      })
      root.add(body)
      f.setup.renderer.root.add(root)
      blocks.push(block)
      inputs.push({ ...f.input, block, renderable: root })
    }
    await act(async () => {
      await f.setup.flush()
      await f.setup.renderOnce()
    })
    f.bridge.begin(
      { ...f.frame, window: { ...f.frame.window, blocks } },
      "test",
    )
    for (const input of inputs)
      expect(f.bridge.points(input, f.text)).toBeUndefined()
    expect(f.bridge.diagnostics.pending).toBe(16)
    expect(f.tasks.tasks.size).toBe(1)
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(1)
    expect(f.bridge.diagnostics.pending).toBe(15)
    while (f.tasks.tasks.size) f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(16)
    expect(f.bridge.diagnostics.pending).toBe(0)
  } finally {
    await f.close()
  }
})

test("native root or body replacement cannot invalidate a departed subtree", async () => {
  const f = await fixture()
  try {
    f.bridge.points(f.input, f.text)
    f.body.destroy()
    const replacement = new TextRenderable(f.setup.renderer, {
      id: "tool-output:command:output-1",
      content: f.text,
      width: 24,
      wrapMode: "word",
    })
    f.root.add(replacement)
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(0)
    expect(f.bridge.diagnostics.stale).toBe(1)
    await act(async () => {
      await f.setup.flush()
      await f.setup.renderOnce()
    })
    f.bridge.points(f.input, f.text)
    f.root.destroy()
    f.tasks.next()
    expect(f.bridge.diagnostics.prepared).toBe(0)
    expect(f.bridge.diagnostics.stale).toBe(2)
  } finally {
    await f.close()
  }
})

async function queuedWindow(viewportFirst: boolean) {
  const viewport = { screenY: 0, height: 1 }
  const f = await fixture(
    "hello world",
    viewportFirst ? () => viewport : undefined,
  )
  const blocks = [f.block]
  const inputs = [f.input]
  const bodies = [f.body]
  for (let index = 2; index <= 20; index++) {
    const block: TranscriptItemBlock = {
      ...f.block,
      key: { ...f.block.key, blockId: `output-${index}` },
    }
    const root = new BoxRenderable(f.setup.renderer, {
      id: `priority-root-${index}`,
      position: "absolute",
      top: index * 3,
      height: 1,
    })
    const body = new TextRenderable(f.setup.renderer, {
      id: `tool-output:command:output-${index}`,
      content: f.text,
      width: 24,
      height: 1,
      wrapMode: "word",
    })
    root.add(body)
    f.setup.renderer.root.add(root)
    blocks.push(block)
    inputs.push({ ...f.input, block, renderable: root })
    bodies.push(body)
  }
  await act(async () => {
    await f.setup.flush()
    await f.setup.renderOnce()
  })
  f.bridge.begin({ ...f.frame, window: { ...f.frame.window, blocks } }, "test")
  return { ...f, viewport, inputs, bodies }
}

for (const viewportFirst of [false, true])
  test(`prepared job ordering uses ${viewportFirst ? "current viewport after enqueue" : "original FIFO by default"}`, async () => {
    const f = await queuedWindow(viewportFirst)
    try {
      for (const input of f.inputs.slice(0, 3)) f.bridge.points(input, f.text)
      // Moving the viewport after enqueue must select the new location, without
      // any change to transcript cursor, focus, source, or mounted window.
      f.viewport.screenY = f.bodies[2]!.screenY
      f.tasks.next()
      const selected = viewportFirst ? 2 : 0
      expect(f.bridge.points(f.inputs[selected]!, f.text)).toBeDefined()
      expect(f.bridge.diagnostics.prepared).toBe(1)
      expect(f.bridge.diagnostics.reprioritized).toBe(viewportFirst ? 1 : 0)
      if (viewportFirst) {
        f.viewport.screenY = f.bodies[1]!.screenY
        f.tasks.next()
        expect(f.bridge.points(f.inputs[1]!, f.text)).toBeDefined()
      }
    } finally {
      await f.close()
    }
  })

test("a new visible preparation displaces distant queued work at capacity", async () => {
  const f = await queuedWindow(true)
  try {
    for (const input of f.inputs.slice(0, 16)) f.bridge.points(input, f.text)
    expect(f.bridge.diagnostics.pending).toBe(16)
    f.viewport.screenY = f.bodies[19]!.screenY
    f.bridge.points(f.inputs[19]!, f.text)
    expect(f.bridge.diagnostics.pending).toBe(16)
    expect(f.bridge.diagnostics.displaced).toBe(1)
    f.tasks.next()
    expect(f.bridge.points(f.inputs[19]!, f.text)).toBeDefined()
    expect(f.bridge.diagnostics.pending).toBe(15)
    // Reprioritization does not weaken stale-window cancellation.
    f.bridge.synchronize({
      ...f.frame,
      window: { ...f.frame.window, blocks: [] },
    })
    expect(f.bridge.diagnostics.pending).toBe(0)
    expect(f.tasks.tasks.size).toBe(0)
  } finally {
    await f.close()
  }
})

test("visible preparation starts around viewport center before its outer edges", async () => {
  const f = await queuedWindow(true)
  try {
    f.viewport.screenY = 0
    f.viewport.height = 60
    f.bridge.points(f.inputs[1]!, f.text)
    f.bridge.points(f.inputs[9]!, f.text)
    f.tasks.next()
    expect(f.bridge.points(f.inputs[9]!, f.text)).toBeDefined()
    expect(f.bridge.diagnostics.prepared).toBe(1)
    expect(f.bridge.diagnostics.pending).toBe(1)
  } finally {
    await f.close()
  }
})

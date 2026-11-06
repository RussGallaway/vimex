import { expect, test } from "bun:test"
import { type Renderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { MarkdownMeasurementCache } from "./markdown-measurement-cache"

test("native cache reuses translation but invalidates text, layout, and descendant replacement", async () => {
  let update!: (value: {
    pad: number
    inner: number
    width: number
    text: string
    key: number
  }) => void
  function Fixture() {
    const [value, set] = useState({
      pad: 0,
      inner: 0,
      width: 20,
      text: "alpha beta",
      key: 0,
    })
    update = set
    return (
      <box paddingLeft={value.pad}>
        <box id="root" width={value.width} paddingLeft={value.inner}>
          <text key={value.key} id="text">
            {value.text}
          </text>
        </box>
      </box>
    )
  }
  const h = await testRender(<Fixture />, { width: 40, height: 10 })
  const cache = new MarkdownMeasurementCache()
  let calls = 0
  const read = () => {
    calls++
    const node = h.renderer.root.findDescendantById("text") as Renderable
    return { 0: { graphemeOffset: 0, x: node.x, y: node.y } }
  }
  const root = () => h.renderer.root.findDescendantById("root") as Renderable
  let state = { pad: 0, inner: 0, width: 20, text: "alpha beta", key: 0 }
  const change = async (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
    await act(async () => {
      update(state)
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
  }
  try {
    await change({})
    const before = cache.measure(root(), "semantic text", read)
    await change({ pad: 3 })
    const shifted = cache.measure(root(), "semantic text", read)
    expect(calls).toBe(1)
    expect(shifted.points).toBe(before.points)
    expect(shifted.originX - before.originX).toBe(3)
    for (const patch of [
      { text: "omega beta" },
      { inner: 2 },
      { width: 8 },
      { key: 1 },
    ]) {
      const previous = calls
      await change(patch)
      cache.measure(root(), "semantic text", read)
      expect(calls).toBe(previous + 1)
    }
    expect(cache.hits).toBe(1)
    expect(Object.isFrozen(shifted.points)).toBe(true)
    cache.retain(new Set())
    expect(cache.size).toBe(0)
    expect(cache.pointCount).toBe(0)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("native cache snapshots in-place line metadata changes and projected source changes", async () => {
  const h = await testRender(
    <box id="root">
      <text id="text">alpha beta</text>
    </box>,
    { width: 30, height: 8 },
  )
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const root = h.renderer.root.findDescendantById("root") as Renderable
    const node = h.renderer.root.findDescendantById("text") as TextRenderable
    const info = node.lineInfo
    Object.defineProperty(node, "lineInfo", {
      configurable: true,
      get: () => info,
    })
    const cache = new MarkdownMeasurementCache()
    let calls = 0
    const read = () => {
      calls++
      return { 0: { graphemeOffset: 0, x: node.x, y: node.y } }
    }
    cache.measure(root, "alpha beta", read)
    cache.measure(root, "alpha beta", read)
    expect(calls).toBe(1)
    info.lineSources[0] = 2
    cache.measure(root, "alpha beta", read)
    expect(calls).toBe(2)
    info.lineStartCols[0] = 3
    cache.measure(root, "alpha beta", read)
    expect(calls).toBe(3)
    cache.measure(root, "omega beta", read)
    expect(calls).toBe(4)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("native cache bounds point and metadata retention and does not cache empty maps", async () => {
  const h = await testRender(
    <box>
      <text id="a">alpha</text>
      <text id="b">beta</text>
    </box>,
    { width: 30, height: 8 },
  )
  try {
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    const a = h.renderer.root.findDescendantById("a") as Renderable
    const b = h.renderer.root.findDescendantById("b") as Renderable
    const read = () => ({
      0: { graphemeOffset: 0, x: 0, y: 0 },
      1: { graphemeOffset: 1, x: 1, y: 0 },
    })
    const cache = new MarkdownMeasurementCache(2, 1)
    cache.measure(a, "alpha", read)
    cache.measure(b, "beta", read)
    expect(cache.size).toBe(1)
    expect(cache.pointCount).toBe(2)
    const misses = cache.misses
    cache.measure(a, "alpha", read)
    expect(cache.misses).toBe(misses + 1)
    const metadata = new MarkdownMeasurementCache(100, 10, 2)
    metadata.measure(a, "alpha", read)
    expect(metadata.size).toBe(0)
    const empty = new MarkdownMeasurementCache()
    empty.measure(a, "alpha", () => ({}))
    empty.measure(a, "alpha", read)
    expect(empty.misses).toBe(2)
    expect(empty.size).toBe(1)
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

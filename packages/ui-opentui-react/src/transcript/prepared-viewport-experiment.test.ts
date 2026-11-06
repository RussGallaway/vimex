import { expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import { PreparedViewportExperiment } from "./prepared-viewport-experiment"

const blocks = (count = 12) =>
  Array.from({ length: count }, (_, block) => ({
    id: `block-${block}`,
    text: Array.from(
      { length: 4 },
      (_, row) => `${String(block).padStart(2, "0")}:${row}`,
    ).join("\n"),
    kind: block % 2 ? ("code" as const) : ("plain" as const),
  }))

function settle(controller: PreparedViewportExperiment) {
  for (let turn = 0; turn < 2000; turn++) {
    controller.advance()
    const frame = controller.frame()
    if (frame.status === "fallback") throw new Error(frame.fallbackReason)
    if (frame.status === "ready" && frame.pending === 0) return frame
    controller.prepare()
  }
  throw new Error("Prepared viewport failed to settle")
}

const absoluteRow = (frame: ReturnType<PreparedViewportExperiment["frame"]>) =>
  frame.top!.blockIndex * 4 + frame.top!.row

test("input admission and resolution never invoke preparation", () => {
  const controller = new PreparedViewportExperiment({
    blocks: blocks(),
    width: 20,
    height: 3,
    startBlock: 4,
  })
  expect(controller.enqueue(3)).toBe(true)
  expect(controller.advance()).toBe(0)
  expect(controller.frame().status).toBe("pending")
  expect(controller.cacheStats).toEqual({
    entries: 0,
    accountedBytes: 0,
    queued: 0,
    queuedCodeUnits: 0,
  })
  expect(absoluteRow(settle(controller))).toBe(19)
  expect(controller.frame().resolved).toBe(1)
})

test("cold traversal retains complete frame then resolves fixed-line destination exactly", () => {
  const controller = new PreparedViewportExperiment({
    blocks: blocks(),
    width: 20,
    height: 3,
    startBlock: 4,
  })
  const initial = settle(controller)
  expect(initial.rows).toEqual(["04:0", "04:1", "04:2"])
  controller.enqueue(5)
  controller.advance()
  const blocked = controller.frame()
  expect(blocked.rows).toHaveLength(3)
  expect(blocked.rows.every(Boolean)).toBe(true)
  expect(blocked.pending).toBe(1)
  const final = settle(controller)
  expect(absoluteRow(final)).toBe(21)
  expect(final.rows).toEqual(["05:1", "05:2", "05:3"])
  expect(final.cursor).toEqual({ x: 0, y: 0 })
  const stopped = controller.state
  for (let i = 0; i < 10; i++) {
    controller.prepare()
    controller.advance()
  }
  expect(controller.state).toBe(stopped)
  expect(controller.frame()).toEqual(final)
})

test("ordered reversal at document edge cannot collapse into net displacement", () => {
  const controller = new PreparedViewportExperiment({
    blocks: blocks(),
    width: 20,
    height: 3,
  })
  controller.enqueue(-3)
  controller.enqueue(2)
  const final = settle(controller)
  expect(absoluteRow(final)).toBe(2)
  expect(final.accepted).toBe(2)
  expect(final.resolved).toBe(2)
})

test("held half-page queue reverses through cold blocks and stops at independent destination", () => {
  const controller = new PreparedViewportExperiment({
    blocks: blocks(80),
    width: 20,
    height: 6,
    startBlock: 40,
  })
  settle(controller)
  const deltas = [...Array<number>(20).fill(-3), ...Array<number>(13).fill(3)]
  let expected = 160
  for (const delta of deltas) {
    expect(controller.enqueue(delta)).toBe(true)
    expected = Math.min(319, Math.max(0, expected + delta))
  }
  const final = settle(controller)
  expect(absoluteRow(final)).toBe(expected)
  expect(final.pending).toBe(0)
  expect(final.resolved).toBe(deltas.length)
  expect(final.rows[0]).toBe(
    `${String(Math.floor(expected / 4)).padStart(2, "0")}:${expected % 4}`,
  )
})

test("selection and copy use canonical domain state across newline boundaries", () => {
  const controller = new PreparedViewportExperiment({
    blocks: [{ id: "a", text: "first\nsecond\nthird" }],
    width: 20,
    height: 2,
  })
  settle(controller)
  controller.beginSelection()
  controller.enqueue(1)
  settle(controller)
  expect(controller.state.selection?.head).toEqual(controller.state.cursor)
  expect(controller.state.viewport.kind).toBe("point")
  expect(controller.copy()).toBe("first\n")
  expect(controller.copy("source")).toBe("first\n")
})

test("selection copies canonical content across soft wraps and block boundaries", () => {
  const controller = new PreparedViewportExperiment({
    blocks: [
      { id: "a", text: "abcdef" },
      { id: "b", text: "ghijkl" },
    ],
    width: 3,
    height: 2,
  })
  expect(settle(controller).rows).toEqual(["abc", "def"])
  controller.beginSelection()
  controller.enqueue(2)
  const frame = settle(controller)
  expect(frame.rows).toEqual(["ghi", "jkl"])
  expect(controller.state.cursor).toEqual({
    itemId: itemId("b"),
    graphemeOffset: 0,
  })
  expect(controller.copy()).toBe("abcdef\ng")
  expect(controller.copy("source")).toBe("abcdef\ng")
})

test("bounded pending input reports refusal without dropping accepted commands", () => {
  const controller = new PreparedViewportExperiment({
    blocks: blocks(),
    width: 20,
    height: 3,
  })
  for (let i = 0; i < 128; i++) expect(controller.enqueue(1)).toBe(true)
  expect(controller.enqueue(1)).toBe(false)
  expect(controller.enqueue(0)).toBe(false)
  const final = settle(controller)
  expect(final.accepted).toBe(128)
  expect(final.resolved).toBe(128)
  expect(absoluteRow(final)).toBe(47)
})

test("unsupported text surfaces fallback rather than accepting approximate geometry", () => {
  const controller = new PreparedViewportExperiment({
    blocks: [{ id: "tab", text: "a\tb" }],
    width: 20,
    height: 3,
  })
  expect(controller.frame().status).toBe("pending")
  expect(controller.prepare().unsupported).toBe(1)
  expect(controller.frame().status).toBe("fallback")
  expect(controller.enqueue(1)).toBe(false)
  expect(controller.state.cursor?.graphemeOffset).toBe(0)
})

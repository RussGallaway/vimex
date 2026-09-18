import { describe, expect, test } from "bun:test"
import { consumeSequence, initialInteraction, reduceInteraction, repeatCount } from "./index"

describe("interaction", () => {
  test("implements only Vim modes and clears count/pending state on transitions", () => {
    let state = reduceInteraction(initialInteraction(), { type: "count.push", digit: 0 })
    expect(state.count).toBe("")
    state = reduceInteraction(state, { type: "count.push", digit: 2 })
    state = reduceInteraction(state, { type: "count.push", digit: 5 })
    state = reduceInteraction(state, { type: "keys.pending", value: "g" })
    expect(repeatCount(state)).toBe(25)
    const consumed = consumeSequence(state)
    expect(consumed).toMatchObject({ count: 25, pendingKeys: "g" })
    expect(consumed.state).toMatchObject({ count: "", pendingKeys: "" })
    expect(reduceInteraction(state, { type: "mode.insert" })).toMatchObject({ mode: "insert", surface: "composer", count: "", pendingKeys: "" })
  })

  test("moving from insert to transcript returns to normal", () => {
    const insert = reduceInteraction(initialInteraction(), { type: "mode.insert" })
    expect(reduceInteraction(insert, { type: "focus.set", surface: "transcript" })).toMatchObject({ mode: "normal", surface: "transcript" })
  })

  test("escape enters normal mode on the composer surface", () => {
    const insert = reduceInteraction(initialInteraction(), { type: "mode.insert" })
    expect(reduceInteraction(insert, { type: "mode.normal" })).toMatchObject({ mode: "normal", surface: "composer" })
  })

  test("stores the unnamed register in per-workspace interaction state", () => {
    const state = reduceInteraction(initialInteraction(), {
      type: "register.set",
      register: { text: "two lines", shape: "line" },
    })
    expect(state.unnamedRegister).toEqual({ text: "two lines", shape: "line" })
  })
})

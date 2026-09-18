import { describe, expect, test } from "bun:test"
import { applyComposerVimAction, type ComposerBuffer } from "./composer-buffer"
import type { ComposerMotion, ComposerVimAction } from "./composer-grammar"
import type { VimRegister } from "./state-machine"

const emptyRegister: VimRegister = { text: "", shape: "character" }
const apply = (buffer: ComposerBuffer, action: ComposerVimAction, register = emptyRegister) => applyComposerVimAction(buffer, action, register)
const motion = (buffer: ComposerBuffer, value: ComposerMotion, count = 1) => apply(buffer, { type: "motion", motion: value, count, select: false }).buffer

describe("pure composer Vim buffer", () => {
  test("implements word, line, vertical, and document motions in graphemes", () => {
    const buffer = { text: "  alpha beta\nlast 👨‍👩‍👧‍👦", cursorOffset: 2 }
    expect(motion(buffer, "word-end").cursorOffset).toBe(6)
    expect(motion(buffer, "word-forward").cursorOffset).toBe(8)
    expect(motion(buffer, "first-content").cursorOffset).toBe(2)
    expect(motion(buffer, "line-end").cursorOffset).toBe(11)
    expect(motion(buffer, "down").cursorOffset).toBe(15)
    expect(motion({ ...buffer, cursorOffset: 15 }, "up").cursorOffset).toBe(2)
    expect(motion(buffer, "document-start").cursorOffset).toBe(2)
    expect(motion(buffer, "document-end", 0).cursorOffset).toBe(13)
    expect(motion(buffer, "document-start", 2).cursorOffset).toBe(13)
  })

  test("deletes characters, lines, and to line end into the unnamed register", () => {
    const x = apply({ text: "abcd", cursorOffset: 1 }, { type: "edit", operator: "delete-char", count: 2 })
    expect(x).toMatchObject({ buffer: { text: "ad", cursorOffset: 1 }, register: { text: "bc", shape: "character" } })

    const dd = apply({ text: "one\ntwo\nthree", cursorOffset: 5 }, { type: "edit", operator: "delete-line", count: 2 })
    expect(dd).toMatchObject({ buffer: { text: "one", cursorOffset: 2 }, register: { text: "two\nthree", shape: "line" } })

    const d = apply({ text: "one two\nthree", cursorOffset: 4 }, { type: "edit", operator: "delete-to-line-end", count: 1 })
    expect(d).toMatchObject({ buffer: { text: "one \nthree", cursorOffset: 3 }, register: { text: "two", shape: "character" } })
    const c = apply({ text: "one two", cursorOffset: 4 }, { type: "edit", operator: "delete-to-line-end", count: 1, enterInsert: true })
    expect(c.buffer).toEqual({ text: "one ", cursorOffset: 4 })
  })

  test("pastes characterwise and linewise registers with Vim placement", () => {
    const character: VimRegister = { text: "X", shape: "character" }
    expect(apply({ text: "abc", cursorOffset: 1 }, { type: "paste", placement: "after", count: 1 }, character).buffer)
      .toEqual({ text: "abXc", cursorOffset: 2 })
    expect(apply({ text: "abc", cursorOffset: 1 }, { type: "paste", placement: "before", count: 2 }, character).buffer)
      .toEqual({ text: "aXXbc", cursorOffset: 2 })

    const line: VimRegister = { text: "  cut", shape: "line" }
    expect(apply({ text: "one\ntwo", cursorOffset: 1 }, { type: "paste", placement: "after", count: 1 }, line).buffer)
      .toEqual({ text: "one\n  cut\ntwo", cursorOffset: 6 })
    expect(apply({ text: "one\ntwo", cursorOffset: 5 }, { type: "paste", placement: "before", count: 1 }, line).buffer)
      .toEqual({ text: "one\n  cut\ntwo", cursorOffset: 6 })
  })

  test("places i/a/I/A and opens lines above or below", () => {
    const buffer = { text: "  one\ntwo", cursorOffset: 3 }
    expect(apply(buffer, { type: "enter-insert", placement: "before" }).buffer.cursorOffset).toBe(3)
    expect(apply(buffer, { type: "enter-insert", placement: "after" }).buffer.cursorOffset).toBe(4)
    expect(apply(buffer, { type: "enter-insert", placement: "line-start" }).buffer.cursorOffset).toBe(2)
    expect(apply(buffer, { type: "enter-insert", placement: "line-end" }).buffer.cursorOffset).toBe(5)
    expect(apply(buffer, { type: "open-line", placement: "below", count: 1 }).buffer).toEqual({ text: "  one\n\ntwo", cursorOffset: 6 })
    expect(apply(buffer, { type: "open-line", placement: "above", count: 1 }).buffer).toEqual({ text: "\n  one\ntwo", cursorOffset: 0 })
  })

  test("extends and yanks an inclusive visual selection", () => {
    const begun = apply({ text: "alpha", cursorOffset: 1 }, { type: "begin-visual" }).buffer
    const selected = apply(begun, { type: "motion", motion: "right", count: 2, select: true }).buffer
    expect(selected.selection).toEqual({ anchor: 1, head: 3 })
    const yanked = apply(selected, { type: "yank" })
    expect(yanked).toEqual({
      buffer: { text: "alpha", cursorOffset: 3 },
      register: { text: "lph", shape: "character" },
      effect: { type: "copy", text: "lph" },
    })
  })

  test("returns submit and history as typed effects", () => {
    const buffer = { text: "send", cursorOffset: 3 }
    expect(apply(buffer, { type: "submit" }).effect).toEqual({ type: "submit" })
    expect(apply(buffer, { type: "edit", operator: "undo", count: 1 }).effect).toEqual({ type: "history", direction: "undo" })
  })
})

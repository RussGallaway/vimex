import { describe, expect, test } from "bun:test"
import {
  applyComposerVimAction,
  codeUnitOffsetToGraphemeOffset,
  graphemeOffsetToCodeUnitOffset,
  type ComposerBuffer,
} from "./composer-buffer"
import { resolveComposerKey, type ComposerMotion, type ComposerVimAction } from "./composer-grammar"
import { initialInteraction, reduceInteraction, type InteractionState, type VimRegister } from "./state-machine"

const emptyRegister: VimRegister = { text: "", shape: "character" }
const apply = (buffer: ComposerBuffer, action: ComposerVimAction, register = emptyRegister) => applyComposerVimAction(buffer, action, register)
const motion = (buffer: ComposerBuffer, value: ComposerMotion, count = 1) => apply(buffer, { type: "motion", motion: value, count, select: false }).buffer

function applyKeys(text: string, keys: readonly string[]): { buffer: ComposerBuffer; register: VimRegister; interaction: InteractionState } {
  let buffer: ComposerBuffer = { text, cursorOffset: Math.max(0, splitForTest(text).length - 1) }
  let register = emptyRegister
  let interaction = reduceInteraction(initialInteraction(), { type: "focus.set", surface: "composer" })
  for (const key of keys) {
    const resolved = resolveComposerKey(interaction, key)
    interaction = resolved.state
    if (!resolved.action) continue
    const result = applyComposerVimAction(buffer, resolved.action, register)
    buffer = result.buffer
    register = result.register
  }
  return { buffer, register, interaction }
}

const splitForTest = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ segment }) => segment)

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

  test("preserves the desired column across counted vertical movement", () => {
    const buffer = { text: "abcdef\nx\nabcdef", cursorOffset: 5 }
    expect(motion(buffer, "down", 2).cursorOffset).toBe(14)
  })

  test("treats combining-mark graphemes as keyword characters", () => {
    const buffer = { text: "élan noir", cursorOffset: 0 }
    expect(motion(buffer, "word-end").cursorOffset).toBe(3)
    expect(motion(buffer, "word-forward").cursorOffset).toBe(5)
  })

  test("converts UTF-16 textarea offsets without splitting graphemes", () => {
    const text = "A😀éZ"
    expect(codeUnitOffsetToGraphemeOffset(text, 0)).toBe(0)
    expect(codeUnitOffsetToGraphemeOffset(text, 1)).toBe(1)
    expect(codeUnitOffsetToGraphemeOffset(text, 3)).toBe(2)
    expect(codeUnitOffsetToGraphemeOffset(text, 4)).toBe(2)
    expect(codeUnitOffsetToGraphemeOffset(text, 5)).toBe(3)
    expect(graphemeOffsetToCodeUnitOffset(text, 0)).toBe(0)
    expect(graphemeOffsetToCodeUnitOffset(text, 1)).toBe(1)
    expect(graphemeOffsetToCodeUnitOffset(text, 2)).toBe(3)
    expect(graphemeOffsetToCodeUnitOffset(text, 3)).toBe(5)
    expect(graphemeOffsetToCodeUnitOffset(text, 4)).toBe(6)
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

test("Visual deletion is inclusive, reversible through the register, and grapheme-safe", () => {
  for (const selection of [{ anchor: 1, head: 3 }, { anchor: 3, head: 1 }]) {
    const deleted = apply({ text: "Aé👨‍👩‍👧‍👦\nZ", cursorOffset: selection.head, selection }, { type: "delete-selection" })
    expect(deleted.buffer).toEqual({ text: "AZ", cursorOffset: 1 })
    expect(deleted.register).toEqual({ text: "é👨‍👩‍👧‍👦\n", shape: "character" })
    expect(apply(deleted.buffer, { type: "paste", placement: "before", count: 1 }, deleted.register).buffer.text).toBe("Aé👨‍👩‍👧‍👦\nZ")
  }
  const last = apply({ text: "A😀", cursorOffset: 1, selection: { anchor: 1, head: 1 } }, { type: "delete-selection" })
  expect(last.buffer).toEqual({ text: "A", cursorOffset: 0 })
  expect(apply(last.buffer, { type: "paste", placement: "after", count: 1 }, last.register).buffer.text).toBe("A😀")
  expect(apply({ text: "😀", cursorOffset: 0, selection: { anchor: 0, head: 0 } }, { type: "delete-selection" }).buffer).toEqual({ text: "", cursorOffset: 0 })
})

test("Visual change keeps the insertion boundary at the end of the remaining text", () => {
  expect(apply({ text: "ABC", cursorOffset: 2, selection: { anchor: 1, head: 2 } }, { type: "delete-selection", enterInsert: true }).buffer).toEqual({ text: "A", cursorOffset: 1 })
})

test("whole-buffer Visual deletion includes explicit line boundaries", () => {
  const text = "Draft stays separate from status"

  // Vim's G lands on the first nonblank character of the last line. On a
  // single-line buffer, ggvG therefore selects only that first character.
  const columnPreserving = applyKeys(text, ["g", "g", "v", "shift+g", "d"])
  expect(columnPreserving.buffer.text).toBe("raft stays separate from status")
  expect(columnPreserving.register).toEqual({ text: "D", shape: "character" })

  // 0 and $ make the intended whole-buffer characterwise range explicit and
  // work for both one-line and multiline drafts.
  for (const value of [text, "first line\nsecond line"]) {
    const deleted = applyKeys(value, ["g", "g", "0", "v", "shift+g", "$", "d"])
    expect(deleted.buffer).toEqual({ text: "", cursorOffset: 0 })
    expect(deleted.register).toEqual({ text: value, shape: "character" })
    expect(deleted.interaction.mode).toBe("normal")
  }
})

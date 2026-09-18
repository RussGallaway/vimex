import { describe, expect, test } from "bun:test"
import { initialInteraction, reduceInteraction } from "./state-machine"
import { resolveComposerKey } from "./composer-grammar"

const composerNormal = () => reduceInteraction(initialInteraction(), { type: "focus.set", surface: "composer" })

describe("composer Vim grammar", () => {
  test("owns count accumulation and consumption for motions", () => {
    const two = resolveComposerKey(composerNormal(), "2")
    const motion = resolveComposerKey(two.state, "w")
    expect(two.state.count).toBe("2")
    expect(motion.action).toEqual({ type: "motion", motion: "word-forward", count: 2, select: false })
    expect(motion.state.count).toBe("")
    expect(resolveComposerKey(composerNormal(), "e").action).toEqual({ type: "motion", motion: "word-end", count: 1, select: false })
    expect(resolveComposerKey(composerNormal(), "^").action).toEqual({ type: "motion", motion: "first-content", count: 1, select: false })
  })

  test("distinguishes zero motion from a zero in a count", () => {
    expect(resolveComposerKey(composerNormal(), "0").action).toEqual({ type: "motion", motion: "line-start", count: 1, select: false })
    const ten = resolveComposerKey(resolveComposerKey(composerNormal(), "1").state, "0")
    expect(ten.state.count).toBe("10")
    expect(ten.action).toBeUndefined()
  })

  test("owns g and d prefixes, including counts", () => {
    const two = resolveComposerKey(composerNormal(), "2")
    const pendingG = resolveComposerKey(two.state, "g")
    expect(pendingG.state).toMatchObject({ count: "2", pendingKeys: "g" })
    const gg = resolveComposerKey(pendingG.state, "g")
    expect(gg.action).toEqual({ type: "motion", motion: "document-start", count: 2, select: false })
    expect(gg.state).toMatchObject({ count: "", pendingKeys: "" })

    const pendingD = resolveComposerKey(composerNormal(), "d")
    expect(resolveComposerKey(pendingD.state, "d").action).toEqual({ type: "edit", operator: "delete-line", count: 1 })
    expect(resolveComposerKey(composerNormal(), "gg").action).toEqual({ type: "motion", motion: "document-start", count: 1, select: false })
    expect(resolveComposerKey(composerNormal(), "shift+g").action).toEqual({ type: "motion", motion: "document-end", count: 0, select: false })
  })

  test("resolves deletes, changes, paste, and insert/open placements", () => {
    const counted = resolveComposerKey(resolveComposerKey(composerNormal(), "3").state, "dd")
    expect(counted.action).toEqual({ type: "edit", operator: "delete-line", count: 3 })
    expect(resolveComposerKey(composerNormal(), "shift+d").action).toEqual({ type: "edit", operator: "delete-to-line-end", count: 1 })
    const change = resolveComposerKey(composerNormal(), "shift+c")
    expect(change.action).toEqual({ type: "edit", operator: "delete-to-line-end", count: 1, enterInsert: true })
    expect(change.state.mode).toBe("insert")
    expect(resolveComposerKey(composerNormal(), "p").action).toEqual({ type: "paste", placement: "after", count: 1 })
    expect(resolveComposerKey(composerNormal(), "shift+p").action).toEqual({ type: "paste", placement: "before", count: 1 })

    for (const [key, placement] of [["i", "before"], ["a", "after"], ["shift+i", "line-start"], ["shift+a", "line-end"]] as const) {
      const resolution = resolveComposerKey(composerNormal(), key)
      expect(resolution.action).toEqual({ type: "enter-insert", placement })
      expect(resolution.state.mode).toBe("insert")
    }
    expect(resolveComposerKey(composerNormal(), "o").action).toEqual({ type: "open-line", placement: "below", count: 1 })
    expect(resolveComposerKey(composerNormal(), "shift+o").action).toEqual({ type: "open-line", placement: "above", count: 1 })
  })

  test("owns visual selection motion, yank, and escape transitions", () => {
    const visual = resolveComposerKey(composerNormal(), "v")
    expect(visual.action).toEqual({ type: "begin-visual" })
    const moved = resolveComposerKey(resolveComposerKey(visual.state, "2").state, "e")
    expect(moved.action).toEqual({ type: "motion", motion: "word-end", count: 2, select: true })
    const yanked = resolveComposerKey(moved.state, "y")
    expect(yanked.action).toEqual({ type: "yank" })
    expect(yanked.state).toMatchObject({ mode: "normal", surface: "composer" })
    const escaped = resolveComposerKey(visual.state, "escape")
    expect(escaped.action).toEqual({ type: "clear-selection" })
    expect(escaped.state.surface).toBe("transcript")
  })

  test("submits from Normal Enter and retains retry as a semantic action", () => {
    expect(resolveComposerKey(composerNormal(), "return").action).toEqual({ type: "submit" })
    expect(resolveComposerKey(composerNormal(), "enter").action).toEqual({ type: "submit" })
    expect(resolveComposerKey(composerNormal(), "shift+r").action).toEqual({ type: "retry" })
  })
})

test("Visual d/x delete into Normal while c changes into Insert", () => {
  const visual = resolveComposerKey(composerNormal(), "v").state
  for (const key of ["d", "x", "c"]) {
    const result = resolveComposerKey(visual, key)
    expect(result.action).toEqual({ type: "delete-selection", enterInsert: key === "c" })
    expect(result.state.mode).toBe(key === "c" ? "insert" : "normal")
    expect(result.state.surface).toBe("composer")
    expect(result.state.pendingKeys).toBe("")
  }
})

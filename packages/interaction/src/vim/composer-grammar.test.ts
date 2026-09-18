import { describe, expect, test } from "bun:test"
import { initialInteraction, reduceInteraction } from "./state-machine"
import { resolveComposerKey } from "./composer-grammar"

const composerNormal = () => reduceInteraction(initialInteraction(), { type: "focus.set", surface: "composer" })

describe("composer Vim grammar", () => {
  test("owns count accumulation and consumption for normal motions", () => {
    const two = resolveComposerKey(composerNormal(), "2")
    const motion = resolveComposerKey(two.state, "w")
    expect(two.state.count).toBe("2")
    expect(motion.action).toEqual({ type: "motion", motion: "word-forward", count: 2, select: false })
    expect(motion.state.count).toBe("")
  })

  test("distinguishes zero motion from a zero in a count", () => {
    expect(resolveComposerKey(composerNormal(), "0").action).toEqual({ type: "motion", motion: "line-start", count: 1, select: false })
    const ten = resolveComposerKey(resolveComposerKey(composerNormal(), "1").state, "0")
    expect(ten.state.count).toBe("10")
    expect(ten.action).toBeUndefined()
  })

  test("resolves counted operators and insert placements", () => {
    const counted = resolveComposerKey(resolveComposerKey(composerNormal(), "3").state, "dd")
    expect(counted.action).toEqual({ type: "edit", operator: "delete-line", count: 3 })
    const append = resolveComposerKey(composerNormal(), "shift+a")
    expect(append.action).toEqual({ type: "enter-insert", placement: "line-end" })
    expect(append.state.mode).toBe("insert")
  })

  test("owns visual selection motion, yank, and escape transitions", () => {
    const visual = resolveComposerKey(composerNormal(), "v")
    expect(visual.action).toEqual({ type: "begin-visual" })
    const moved = resolveComposerKey(resolveComposerKey(visual.state, "2").state, "l")
    expect(moved.action).toEqual({ type: "motion", motion: "right", count: 2, select: true })
    const yanked = resolveComposerKey(moved.state, "y")
    expect(yanked.action).toEqual({ type: "yank" })
    expect(yanked.state.mode).toBe("normal")
    expect(yanked.state.surface).toBe("composer")
    const escaped = resolveComposerKey(visual.state, "escape")
    expect(escaped.action).toEqual({ type: "clear-selection" })
    expect(escaped.state.surface).toBe("transcript")
  })

  test("exposes retry as a semantic action", () => {
    expect(resolveComposerKey(composerNormal(), "shift+r").action).toEqual({ type: "retry" })
  })
})

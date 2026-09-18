import { repeatCount } from "./count"
import { reduceInteraction, type InteractionCommand, type InteractionState } from "./state-machine"

export type ComposerMotion = "left" | "right" | "up" | "down" | "word-forward" | "word-backward" | "line-start" | "line-end"
export type ComposerOperator = "delete-char" | "delete-line" | "undo" | "redo"
export type ComposerPlacement = "before" | "after" | "line-start" | "line-end"

export type ComposerVimAction =
  | { type: "motion"; motion: ComposerMotion; count: number; select: boolean }
  | { type: "edit"; operator: ComposerOperator; count: number }
  | { type: "enter-insert"; placement: ComposerPlacement }
  | { type: "begin-visual" }
  | { type: "clear-selection" }
  | { type: "yank" }
  | { type: "retry" }

export interface ComposerKeyResolution {
  state: InteractionState
  commands: readonly InteractionCommand[]
  action?: ComposerVimAction
}

const motions: Readonly<Record<string, ComposerMotion>> = {
  h: "left", j: "down", k: "up", l: "right", w: "word-forward", b: "word-backward", "$": "line-end",
}
const operators: Readonly<Record<string, ComposerOperator>> = {
  x: "delete-char", dd: "delete-line", u: "undo", "ctrl+r": "redo",
}
const placements: Readonly<Record<string, ComposerPlacement>> = {
  i: "before", a: "after", "shift+i": "line-start", "shift+a": "line-end",
}

function resolved(state: InteractionState, commands: readonly InteractionCommand[], action?: ComposerVimAction): ComposerKeyResolution {
  return { state: commands.reduce(reduceInteraction, state), commands, action }
}

/** Resolves Vim meaning while leaving native cursor geometry and buffer edits to the renderer adapter. */
export function resolveComposerKey(state: InteractionState, key: string): ComposerKeyResolution {
  if (state.surface !== "composer") return resolved(state, [])
  if (state.mode === "normal") {
    if (/^[1-9]$/.test(key)) return resolved(state, [{ type: "count.push", digit: Number(key) }])
    if (key === "0" && state.count) return resolved(state, [{ type: "count.push", digit: 0 }])
    const count = repeatCount(state)
    const motion = key === "0" ? "line-start" : motions[key]
    if (motion) return resolved(state, [{ type: "count.clear" }], { type: "motion", motion, count, select: false })
    const operator = operators[key]
    if (operator) return resolved(state, [{ type: "count.clear" }], { type: "edit", operator, count })
    const placement = placements[key]
    if (placement) return resolved(state, [{ type: "mode.insert" }], { type: "enter-insert", placement })
    if (key === "v") return resolved(state, [{ type: "mode.visual" }], { type: "begin-visual" })
    if (key === "shift+r") return resolved(state, [], { type: "retry" })
  }
  if (state.mode === "visual") {
    if (/^[1-9]$/.test(key)) return resolved(state, [{ type: "count.push", digit: Number(key) }])
    if (key === "0" && state.count) return resolved(state, [{ type: "count.push", digit: 0 }])
    const motion = key === "0" ? "line-start" : motions[key]
    if (motion) return resolved(state, [{ type: "count.clear" }], { type: "motion", motion, count: repeatCount(state), select: true })
    if (key === "y") return resolved(state, [{ type: "mode.normal" }], { type: "yank" })
    if (key === "escape") return resolved(state, [{ type: "mode.normal" }, { type: "focus.set", surface: "transcript" }], { type: "clear-selection" })
  }
  return resolved(state, [])
}

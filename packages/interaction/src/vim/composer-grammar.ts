import { repeatCount } from "./count"
import { reduceInteraction, type InteractionCommand, type InteractionState } from "./state-machine"

export type ComposerMotion =
  | "left" | "right" | "up" | "down"
  | "word-forward" | "word-backward" | "word-end"
  | "line-start" | "first-content" | "line-end"
  | "document-start" | "document-end"
export type ComposerOperator = "delete-char" | "delete-line" | "delete-to-line-end" | "undo" | "redo"
export type ComposerPlacement = "before" | "after" | "line-start" | "line-end"

export type ComposerVimAction =
  | { type: "motion"; motion: ComposerMotion; count: number; select: boolean }
  | { type: "edit"; operator: ComposerOperator; count: number; enterInsert?: boolean }
  | { type: "paste"; placement: "before" | "after"; count: number }
  | { type: "enter-insert"; placement: ComposerPlacement }
  | { type: "open-line"; placement: "above" | "below"; count: number }
  | { type: "begin-visual" }
  | { type: "clear-selection" }
  | { type: "yank" }
  | { type: "delete-selection"; enterInsert?: boolean }
  | { type: "submit" }
  | { type: "retry" }

export interface ComposerKeyResolution {
  state: InteractionState
  commands: readonly InteractionCommand[]
  action?: ComposerVimAction
}

const motions: Readonly<Record<string, ComposerMotion>> = {
  h: "left", j: "down", k: "up", l: "right",
  w: "word-forward", b: "word-backward", e: "word-end",
  "^": "first-content", "$": "line-end", "shift+g": "document-end",
}
const operators: Readonly<Record<string, ComposerOperator>> = {
  x: "delete-char", dd: "delete-line", u: "undo", "ctrl+r": "redo", "shift+d": "delete-to-line-end",
}
const placements: Readonly<Record<string, ComposerPlacement>> = {
  i: "before", a: "after", "shift+i": "line-start", "shift+a": "line-end",
}

function resolved(state: InteractionState, commands: readonly InteractionCommand[], action?: ComposerVimAction): ComposerKeyResolution {
  return { state: commands.reduce(reduceInteraction, state), commands, action }
}

function countCommand(state: InteractionState, key: string): ComposerKeyResolution | undefined {
  if (/^[1-9]$/.test(key)) return resolved(state, [{ type: "count.push", digit: Number(key) }])
  if (key === "0" && state.count) return resolved(state, [{ type: "count.push", digit: 0 }])
  return undefined
}

function prefixed(state: InteractionState, key: string, select: boolean): ComposerKeyResolution | undefined {
  const count = repeatCount(state)
  if (state.pendingKeys === "g") {
    if (key === "g") {
      return resolved(state, [{ type: "keys.clear" }, { type: "count.clear" }], {
        type: "motion", motion: "document-start", count, select,
      })
    }
    return resolved(state, [{ type: "keys.clear" }, { type: "count.clear" }])
  }
  if (state.pendingKeys === "d") {
    if (key === "d" && !select) {
      return resolved(state, [{ type: "keys.clear" }, { type: "count.clear" }], {
        type: "edit", operator: "delete-line", count,
      })
    }
    return resolved(state, [{ type: "keys.clear" }, { type: "count.clear" }])
  }
  return undefined
}

function resolveMotion(state: InteractionState, key: string, select: boolean): ComposerKeyResolution | undefined {
  const count = key === "shift+g" && state.count === "" ? 0 : repeatCount(state)
  const motion = key === "0" ? "line-start" : key === "gg" ? "document-start" : motions[key]
  if (!motion) return undefined
  return resolved(state, [{ type: "count.clear" }, { type: "keys.clear" }], { type: "motion", motion, count, select })
}

/** Resolves composer keys into typed Vim actions; buffer semantics live in composer-buffer. */
export function resolveComposerKey(state: InteractionState, key: string): ComposerKeyResolution {
  if (state.surface !== "composer") return resolved(state, [])
  if (state.mode === "normal") {
    const pending = prefixed(state, key, false)
    if (pending) return pending
    const counted = countCommand(state, key)
    if (counted) return counted
    if (key === "g" || key === "d") return resolved(state, [{ type: "keys.pending", value: key }])
    const motion = resolveMotion(state, key, false)
    if (motion) return motion
    const count = repeatCount(state)
    const operator = operators[key]
    if (operator) return resolved(state, [{ type: "count.clear" }], { type: "edit", operator, count })
    if (key === "shift+c") {
      return resolved(state, [{ type: "count.clear" }, { type: "mode.insert" }], {
        type: "edit", operator: "delete-to-line-end", count, enterInsert: true,
      })
    }
    if (key === "p" || key === "shift+p") {
      return resolved(state, [{ type: "count.clear" }], { type: "paste", placement: key === "p" ? "after" : "before", count })
    }
    const placement = placements[key]
    if (placement) return resolved(state, [{ type: "count.clear" }, { type: "mode.insert" }], { type: "enter-insert", placement })
    if (key === "o" || key === "shift+o") {
      return resolved(state, [{ type: "count.clear" }, { type: "mode.insert" }], {
        type: "open-line", placement: key === "o" ? "below" : "above", count,
      })
    }
    if (key === "v") return resolved(state, [{ type: "count.clear" }, { type: "mode.visual" }], { type: "begin-visual" })
    if (key === "return" || key === "enter") return resolved(state, [{ type: "count.clear" }], { type: "submit" })
    if (key === "shift+r") return resolved(state, [{ type: "count.clear" }], { type: "retry" })
  }
  if (state.mode === "visual") {
    const pending = prefixed(state, key, true)
    if (pending) return pending
    const counted = countCommand(state, key)
    if (counted) return counted
    if (key === "g") return resolved(state, [{ type: "keys.pending", value: key }])
    const motion = resolveMotion(state, key, true)
    if (motion) return motion
    if (key === "d" || key === "x" || key === "c") return resolved(state, [{ type: "count.clear" }, { type: "keys.clear" }, { type: key === "c" ? "mode.insert" : "mode.normal" }], { type: "delete-selection", enterInsert: key === "c" })
    if (key === "y") return resolved(state, [{ type: "count.clear" }, { type: "mode.normal" }], { type: "yank" })
    if (key === "escape") return resolved(state, [{ type: "mode.normal" }, { type: "focus.set", surface: "transcript" }], { type: "clear-selection" })
  }
  return resolved(state, [])
}

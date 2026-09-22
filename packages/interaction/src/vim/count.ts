import type { InteractionState } from "./state-machine"
export function repeatCount(state: InteractionState): number {
  return state.count === "" ? 1 : Math.max(1, Number.parseInt(state.count, 10))
}
export function consumeSequence(state: InteractionState): {
  state: InteractionState
  count: number
  pendingKeys: string
} {
  return {
    state: { ...state, count: "", pendingKeys: "" },
    count: repeatCount(state),
    pendingKeys: state.pendingKeys,
  }
}

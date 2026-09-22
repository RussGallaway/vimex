import type { AgentRelationship } from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"

/** Only confirmed spawning establishes ancestry, including replayed spawn items. */
export function recordAgentRelationship(
  state: WorkbenchState,
  link: AgentRelationship,
): WorkbenchState {
  if (
    link.relation !== "spawned" ||
    state.agentRelationships.some(
      (existing) => existing.childId === link.childId,
    )
  )
    return state
  let ancestor = link.parentId
  const visited = new Set<string>()
  while (!visited.has(ancestor)) {
    if (ancestor === link.childId) return state
    visited.add(ancestor)
    const parent = state.agentRelationships.find(
      (existing) => existing.childId === ancestor,
    )?.parentId
    if (!parent) break
    ancestor = parent
  }
  return { ...state, agentRelationships: [...state.agentRelationships, link] }
}

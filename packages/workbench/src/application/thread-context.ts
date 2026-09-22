import type { ThreadId } from "@vimex/conversation"
import { sideChatForChild } from "./side-chat"
import type { WorkbenchState } from "./workbench-state"

/** A thread's role is independent of which pane displays it or how it was opened. */
export function threadContext(
  state: WorkbenchState,
  id = state.activeThreadId,
): {
  role?: "PARENT" | "CHILD" | "SIDE"
  parentId?: ThreadId
} {
  if (!id) return {}
  const side = sideChatForChild(state, id)
  if (side) return { role: "SIDE", parentId: side.parentId }
  const parent = state.agentRelationships.find((link) => link.childId === id)
  if (parent) return { role: "CHILD", parentId: parent.parentId }
  if (
    state.sideChats[id] ||
    state.agentRelationships.some((link) => link.parentId === id)
  )
    return { role: "PARENT" }
  return {}
}

import {
  setConversationItem,
  type AgentState,
  type ConversationItem,
  type ConversationState,
} from "@vimex/conversation"

function reportedStates(item: ConversationItem): readonly AgentState[] {
  if (item.kind !== "agent") return []
  return item.action === "activity"
    ? item.agentThreadIds.map((threadId) => ({
        threadId,
        status:
          item.activity === "completed"
            ? "complete"
            : item.activity === "interrupted"
              ? "interrupted"
              : "running",
      }))
    : (item.agentStates ?? [])
}

/** Keep the assignment row current without changing the recorded tool outcome. */
export function projectChildTaskProgress(
  previous: ConversationState,
  conversation: ConversationState,
  observed: ConversationItem,
): ConversationState {
  if (observed.kind !== "agent") return conversation
  let updates = reportedStates(observed)
  if (observed.action === "spawn") {
    const prior = previous.items[observed.id]
    if (prior?.kind !== "agent" || !prior.childTasks?.length) {
      // Child notifications can precede the spawn reply that supplies its ID.
      updates = [
        ...updates,
        ...Object.values(previous.items)
          .flatMap((item) =>
            item.kind === "agent" && item.action !== "spawn"
              ? reportedStates(item)
              : [],
          )
          .filter((task) => observed.agentThreadIds.includes(task.threadId)),
      ]
    }
  }
  if (!updates.length && observed.action !== "spawn") return conversation
  let items = conversation.items
  // Only collaboration events visit assignments; ordinary token streaming does not.
  for (const item of Object.values(items)) {
    if (item.kind !== "agent" || item.action !== "spawn") continue
    const prior = previous.items[item.id]
    const retained = prior?.kind === "agent" ? prior.childTasks : undefined
    const tasks = new Map(
      (retained ?? item.childTasks ?? item.agentStates ?? []).map((task) => [
        task.threadId,
        task,
      ]),
    )
    for (const update of updates) {
      if (!item.agentThreadIds.includes(update.threadId)) continue
      // A late spawn completion must not undo a child's newer lifecycle report.
      if (
        observed.id === item.id &&
        retained?.length &&
        JSON.stringify(retained) !==
          JSON.stringify(
            prior?.kind === "agent" ? (prior.agentStates ?? []) : [],
          )
      )
        continue
      const existing = tasks.get(update.threadId)
      tasks.set(update.threadId, {
        ...update,
        ...(update.message === undefined &&
        existing?.status === update.status &&
        existing.message
          ? { message: existing.message }
          : {}),
      })
    }
    const childTasks = [...tasks.values()]
    if (JSON.stringify(childTasks) === JSON.stringify(item.childTasks ?? []))
      continue
    items = setConversationItem(items, { ...item, childTasks })
  }
  return items === conversation.items
    ? conversation
    : { ...conversation, items }
}

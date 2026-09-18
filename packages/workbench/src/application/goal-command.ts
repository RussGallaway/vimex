import type { ConversationGateway, ThreadId, ThreadGoal } from "@vimex/conversation"
import { parseGoalCommand } from "@vimex/interaction"

export function describeGoal(goal: ThreadGoal | null): string {
  if (!goal) return "No goal set. Use /goal <objective> to set one."
  const budget = goal.tokenBudget === null ? `${goal.tokensUsed} tokens` : `${goal.tokensUsed}/${goal.tokenBudget} tokens`
  return `Goal [${goal.status}]: ${goal.objective} · ${budget} · ${Math.floor(goal.timeUsedSeconds)}s`
}
/** Uses the server's persisted goal state, never a synthetic continuation loop. */
export async function executeGoalCommand(gateway: ConversationGateway, id: ThreadId, argument: string): Promise<string> {
  const command = parseGoalCommand(argument)
  if (command.kind === "invalid") throw new Error(command.message)
  if (!gateway.getGoal || !gateway.setGoal || !gateway.clearGoal) throw new Error("Goals are unavailable on this connection")
  if (command.kind === "show") return describeGoal(await gateway.getGoal(id))
  if (command.kind === "clear") return await gateway.clearGoal(id) ? "Goal cleared" : "No goal to clear"
  if (command.kind === "status") return describeGoal(await gateway.setGoal(id, { status: command.status }))
  if (command.kind === "set") return describeGoal(await gateway.setGoal(id, { objective: command.objective, status: "active", ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }) }))
  throw new Error("Unknown goal command")
}

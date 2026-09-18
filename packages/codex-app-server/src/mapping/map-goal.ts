import type { ThreadGoal } from "@vimex/conversation"
import { isRecord } from "../rpc/request-router"
const statuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"])
export function mapGoal(value: unknown): ThreadGoal | undefined {
  if (!isRecord(value) || typeof value.objective !== "string" || typeof value.status !== "string" || !statuses.has(value.status)) return undefined
  if (value.tokenBudget !== null && (typeof value.tokenBudget !== "number" || !Number.isSafeInteger(value.tokenBudget) || value.tokenBudget <= 0)) return undefined
  if (typeof value.tokensUsed !== "number" || !Number.isFinite(value.tokensUsed) || value.tokensUsed < 0 || typeof value.timeUsedSeconds !== "number" || !Number.isFinite(value.timeUsedSeconds) || value.timeUsedSeconds < 0) return undefined
  return { objective: value.objective, status: value.status as ThreadGoal["status"], tokenBudget: value.tokenBudget, tokensUsed: value.tokensUsed, timeUsedSeconds: value.timeUsedSeconds }
}

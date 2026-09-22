export interface ThreadGoal {
  objective: string
  status:
    | "active"
    | "paused"
    | "blocked"
    | "usageLimited"
    | "budgetLimited"
    | "complete"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}
export interface GoalUpdate {
  objective?: string
  status?: ThreadGoal["status"]
  tokenBudget?: number
}

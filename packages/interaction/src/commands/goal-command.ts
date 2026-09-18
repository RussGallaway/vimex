/** Goal command syntax; objectives remain literal, including spaces and punctuation. */
export type GoalCommand = { kind: "show" | "clear" } | { kind: "status"; status: "active" | "paused" | "complete" } | { kind: "set"; objective: string; tokenBudget?: number } | { kind: "invalid"; message: string }
export function parseGoalCommand(argument: string): GoalCommand {
  const text = argument.trim()
  if (!text || text === "show") return { kind: "show" }
  if (text === "clear") return { kind: "clear" }
  if (text === "pause" || text === "resume" || text === "complete") return { kind: "status", status: text === "pause" ? "paused" : text === "resume" ? "active" : "complete" }
  let objective = text.startsWith("set ") ? text.slice(4).trim() : text
  let tokenBudget: number | undefined
  if (objective.startsWith("--budget")) {
    const match = /^--budget\s+(\d+)\s+([\s\S]+)$/.exec(objective)
    tokenBudget = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) return { kind: "invalid", message: "Usage: :goal --budget <positive token count> <objective>" }
    objective = match![2]!.trim()
  }
  if (text === "set" || !objective || [...objective].length > 4000) return { kind: "invalid", message: "Goal objective must contain 1–4000 characters" }
  return { kind: "set", objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }
}

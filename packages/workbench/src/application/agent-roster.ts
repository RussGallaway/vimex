import type {
  AgentRelationship,
  AgentState,
  ThreadId,
} from "@vimex/conversation"
import { sideChatForChild } from "./side-chat"
import type { WorkbenchState } from "./workbench-state"

export interface AgentRosterRow {
  threadId: ThreadId
  parentId: ThreadId
  name: string
  assignment?: string
  result?: string
  status: "running" | "complete" | "error" | "interrupted"
  updatedAt: number
}

/** The focused child and a focused /side pane both retain the root conversation. */
export function agentRosterRoot(
  state: WorkbenchState,
  focused = state.activeThreadId,
): ThreadId | undefined {
  if (!focused) return undefined
  let current = sideChatForChild(state, focused)?.parentId ?? focused
  const visited = new Set<ThreadId>()
  while (!visited.has(current)) {
    visited.add(current)
    const parent = state.agentRelationships.find(
      (link) =>
        link.childId === current &&
        link.relation === "spawned" &&
        !sideChatForChild(state, current),
    )?.parentId
    if (!parent) break
    current = parent
  }
  return current
}

interface ReportedTask {
  assignment?: string
  agentPath?: string
  progress?: AgentState
  completedMessage?: string
  hasSpawn?: boolean
}

/** One parent transcript scan serves every child in its roster. */
function reportedTasks(
  state: WorkbenchState,
  parentId: ThreadId,
): Map<ThreadId, ReportedTask> {
  const reports = new Map<ThreadId, ReportedTask>()
  for (const item of Object.values(
    state.workspaces[parentId]?.conversation.items ?? {},
  )) {
    if (item.kind !== "agent") continue
    if (item.action === "spawn")
      for (const childId of item.agentThreadIds) {
        const report = reports.get(childId) ?? {}
        report.hasSpawn = true
        report.assignment ??= item.detail || undefined
        report.agentPath ??= item.agentPath
        report.progress =
          (item.childTasks ?? item.agentStates)?.find(
            (task) => task.threadId === childId,
          ) ?? report.progress
        reports.set(childId, report)
      }
    for (const progress of item.agentStates ?? []) {
      const report = reports.get(progress.threadId) ?? {}
      if (!report.hasSpawn) report.progress = progress
      if (progress.status === "running" || progress.status === "pending")
        report.completedMessage = undefined
      else if (progress.status === "complete" && progress.message)
        report.completedMessage = progress.message
      reports.set(progress.threadId, report)
    }
  }
  return reports
}

function statusOf(progress?: AgentState): AgentRosterRow["status"] {
  switch (progress?.status) {
    case "complete":
    case "closed":
      return "complete"
    case "error":
    case "missing":
      return "error"
    case "interrupted":
      return "interrupted"
    default:
      return "running"
  }
}

/** Only spawned descendants appear here; side forks are never agent rows. */
export function agentRoster(
  state: WorkbenchState,
  focused = state.activeThreadId,
): AgentRosterRow[] {
  const root = agentRosterRoot(state, focused)
  if (!root) return []
  const rows: AgentRosterRow[] = []
  const visited = new Set<ThreadId>([root])
  const children = new Map<ThreadId, AgentRelationship[]>()
  const reports = new Map<ThreadId, Map<ThreadId, ReportedTask>>()
  for (const link of state.agentRelationships)
    if (link.relation === "spawned") {
      const siblings = children.get(link.parentId)
      if (siblings) siblings.push(link)
      else children.set(link.parentId, [link])
    }
  const visit = (parentId: ThreadId) => {
    let parentReports = reports.get(parentId)
    if (!parentReports) {
      parentReports = reportedTasks(state, parentId)
      reports.set(parentId, parentReports)
    }
    for (const link of children.get(parentId) ?? []) {
      if (
        visited.has(link.childId) ||
        sideChatForChild(state, link.childId) ||
        state.retiredSideThreadIds.includes(link.childId)
      )
        continue
      visited.add(link.childId)
      const summary = state.summaries[link.childId]
      const task = parentReports.get(link.childId)
      const status = statusOf(task?.progress)
      rows.push({
        threadId: link.childId,
        parentId,
        name:
          summary?.agentNickname ||
          task?.agentPath?.split("/").filter(Boolean).at(-1) ||
          link.agentPath?.split("/").filter(Boolean).at(-1) ||
          summary?.agentRole ||
          (summary?.titleSource === "name" ? summary.title : undefined) ||
          `Agent ${rows.length + 1}`,
        assignment: task?.assignment,
        result:
          status === "complete"
            ? (task?.progress?.message ?? task?.completedMessage)
            : undefined,
        status,
        updatedAt: summary?.updatedAt ?? 0,
      })
      visit(link.childId)
    }
  }
  visit(root)
  return rows.sort(
    (a, b) =>
      Number(a.status !== "running") - Number(b.status !== "running") ||
      b.updatedAt - a.updatedAt,
  )
}

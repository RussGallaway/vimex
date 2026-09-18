import type { ThreadId, ThreadSummary } from "@vimex/conversation"

export interface SessionRow { id: ThreadId; summary?: ThreadSummary }

function fuzzyScore(value: string, query: string): number | undefined {
  const haystack = value.toLocaleLowerCase()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0
  let score = 0
  let offset = 0
  let previous = -2
  for (const character of needle) {
    const found = haystack.indexOf(character, offset)
    if (found < 0) return undefined
    score += found === previous + 1 ? 5 : 1
    if (found === 0 || /[\s/_.-]/.test(haystack[found - 1] ?? "")) score += 3
    previous = found
    offset = found + 1
  }
  return score - Math.max(0, haystack.length - needle.length) * 0.01
}

export function searchSessions(threads: readonly ThreadId[], summaries: Readonly<Record<string, ThreadSummary>>, query: string): SessionRow[] {
  return threads.map((id, order) => {
    const summary = summaries[id]
    const searchable = [summary?.title, summary?.cwd, summary?.gitBranch, summary?.model, id].filter(Boolean).join(" ")
    return { id, summary, order, score: fuzzyScore(searchable, query), updatedAt: summary?.updatedAt ?? 0 }
  }).filter((row) => row.score !== undefined)
    .sort((a, b) => query.trim() ? b.score! - a.score! || b.updatedAt - a.updatedAt || a.order - b.order : b.updatedAt - a.updatedAt || a.order - b.order)
    .map(({ id, summary }) => ({ id, summary }))
}

export function sessionRecency(updatedAt?: number): string {
  if (!updatedAt) return ""
  const elapsed = Math.max(0, Date.now() - updatedAt)
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

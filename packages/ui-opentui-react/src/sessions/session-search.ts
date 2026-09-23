import {
  threadId,
  type ThreadId,
  type ThreadSummary,
} from "@vimex/conversation"

export interface SessionRow {
  id: ThreadId
  summary?: ThreadSummary
  favorite?: boolean
}

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

export function searchSessions(
  threads: readonly ThreadId[],
  summaries: Readonly<Record<string, ThreadSummary>>,
  query: string,
  favorites: readonly ThreadId[] = [],
  cwd?: string,
): SessionRow[] {
  const favoriteIds = new Set(favorites)
  const normalize = (path: string) => path.replace(/\/+$/, "") || "/"
  const candidates = [...new Set([...threads, ...favorites])].filter(
    (id) =>
      cwd === undefined ||
      (summaries[id]?.cwd !== undefined &&
        normalize(summaries[id]!.cwd) === normalize(cwd)),
  )
  const exactQuery = query.trim()
  const exact = candidates.find((id) => id === exactQuery)
  if (exact)
    return [
      {
        id: exact,
        summary: summaries[exact],
        ...(favoriteIds.has(exact) ? { favorite: true } : {}),
      },
    ]
  // Codex can resume a known thread that is absent from thread/list (forks and
  // hidden agent threads are common examples). Never fuzzy-match a complete
  // UUID to a different session; offer the typed ID as a resumable target.
  if (
    cwd === undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      exactQuery,
    )
  ) {
    return [{ id: threadId(exactQuery) }]
  }
  const available = candidates.filter((id) => !summaries[id]?.parentThreadId)
  return available
    .map((id, order) => {
      const summary = summaries[id]
      const searchable = [
        summary?.title,
        summary?.cwd,
        summary?.gitBranch,
        summary?.model,
        id,
      ]
        .filter(Boolean)
        .join(" ")
      return {
        id,
        summary,
        order,
        favorite: favoriteIds.has(id),
        score: fuzzyScore(searchable, query),
        updatedAt: summary?.updatedAt ?? 0,
      }
    })
    .filter((row) => row.score !== undefined)
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (query.trim()
          ? b.score! - a.score! ||
            b.updatedAt - a.updatedAt ||
            a.order - b.order
          : b.updatedAt - a.updatedAt || a.order - b.order),
    )
    .map(({ id, summary, favorite }) => ({
      id,
      summary,
      ...(favorite ? { favorite: true } : {}),
    }))
}

export function sessionRecency(updatedAt?: number): string {
  if (!updatedAt) return ""
  const elapsed = Math.max(0, Date.now() - updatedAt)
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

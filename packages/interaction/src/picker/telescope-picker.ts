/**
 * A UI-independent picker model following Telescope's finder/sorter/action
 * split.  The OpenTUI drawer is responsible for rendering this model; this
 * module owns filtering, ranking, cancellation, navigation, and marks.
 */

export interface PickerEntry<T = unknown> {
  id: string
  text: string
  detail?: string
  value: T
}

export interface PickerMatch {
  score: number
  positions: readonly number[]
}

export interface RankedPickerEntry<T = unknown> extends PickerEntry<T> {
  match: PickerMatch
}

export type PickerFinder<T> = (
  signal: AbortSignal,
) => readonly PickerEntry<T>[] | Promise<readonly PickerEntry<T>[]>

/** A small fzf-style subsequence scorer. Higher scores rank first. */
export function fzfScore(query: string, candidate: string): PickerMatch | null {
  const terms = query.trim().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return { score: 0, positions: [] }

  const text = candidate
  const textChars = Array.from(text)
  const lowerText = Array.from(text.toLocaleLowerCase())
  const positions: number[] = []
  let score = 0

  for (const term of terms) {
    const originalTerm = Array.from(term)
    const lowerTerm = Array.from(term.toLocaleLowerCase())
    let cursor = 0
    let previous = -2
    const termPositions: number[] = []
    for (let index = 0; index < lowerTerm.length; index++) {
      const position = lowerText.indexOf(lowerTerm[index]!, cursor)
      if (position < 0) return null
      termPositions.push(position)

      // fzf gives substantial weight to word/path boundaries and consecutive
      // characters. These weights preserve the useful ordering without making
      // the picker depend on a native fzf binary.
      if (position === 0 || /[\s_./\\-]/u.test(textChars[position - 1] ?? "")) {
        score += 16
      }
      if (position === previous + 1) score += 10
      if (textChars[position] === originalTerm[index]) score += 2
      score += Math.max(0, 4 - position * 0.05)
      previous = position
      cursor = position + 1
    }
    positions.push(...termPositions)
  }

  score -=
    Math.max(0, textChars.length - Array.from(terms.join("")).length) * 0.08
  return { score, positions }
}

export interface TelescopePickerOptions<T> {
  finder: PickerFinder<T>
  scorer?: (query: string, candidate: string) => PickerMatch | null
}

export class TelescopePicker<T> {
  private readonly finder: PickerFinder<T>
  private readonly scorer: (
    query: string,
    candidate: string,
  ) => PickerMatch | null
  private entries: readonly PickerEntry<T>[] = []
  private ranked: readonly RankedPickerEntry<T>[] = []
  private marked: string[] = []
  private queryValue = ""
  private cursorValue = 0
  private generation = 0
  private activeAbort: AbortController | undefined

  constructor(options: TelescopePickerOptions<T>) {
    this.finder = options.finder
    this.scorer = options.scorer ?? fzfScore
  }

  get query(): string {
    return this.queryValue
  }

  get cursor(): number {
    return this.cursorValue
  }

  get results(): readonly RankedPickerEntry<T>[] {
    return this.ranked
  }

  get markedIds(): readonly string[] {
    return this.marked
  }

  async refresh(): Promise<readonly RankedPickerEntry<T>[]> {
    this.activeAbort?.abort()
    const abort = new AbortController()
    this.activeAbort = abort
    const request = ++this.generation
    const entries = await this.finder(abort.signal)
    if (abort.signal.aborted || request !== this.generation) return this.ranked
    this.entries = entries
    this.recompute()
    return this.ranked
  }

  setQuery(query: string): readonly RankedPickerEntry<T>[] {
    this.queryValue = query
    this.recompute()
    return this.ranked
  }

  move(delta: number): number {
    if (this.ranked.length === 0) {
      this.cursorValue = 0
      return 0
    }
    const next = this.cursorValue + delta
    this.cursorValue =
      ((next % this.ranked.length) + this.ranked.length) % this.ranked.length
    return this.cursorValue
  }

  toggleMark(): readonly string[] {
    const current = this.ranked[this.cursorValue]
    if (!current) return this.marked
    const index = this.marked.indexOf(current.id)
    if (index >= 0) {
      this.marked = [
        ...this.marked.slice(0, index),
        ...this.marked.slice(index + 1),
      ]
    } else {
      this.marked = [...this.marked, current.id]
    }
    return this.marked
  }

  clearMarks(): void {
    this.marked = []
  }

  /** Returns marks in the order they were made, like Telescope's multi-select. */
  selected(): readonly PickerEntry<T>[] {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]))
    return this.marked.flatMap((id) => {
      const entry = byId.get(id)
      return entry ? [entry] : []
    })
  }

  /** Accept the marks, or the current result when no marks exist. */
  accept(): readonly PickerEntry<T>[] {
    const selected = this.selected()
    if (selected.length > 0) return selected
    const current = this.ranked[this.cursorValue]
    return current ? [current] : []
  }

  dispose(): void {
    this.activeAbort?.abort()
    this.activeAbort = undefined
    this.generation++
  }

  private recompute(): void {
    const next = this.entries.flatMap((entry) => {
      const match = this.scorer(this.queryValue, entry.text)
      return match ? [{ ...entry, match }] : []
    })
    this.ranked = [...next].sort((left, right) => {
      const score = right.match.score - left.match.score
      return score || left.text.localeCompare(right.text)
    })
    this.cursorValue = Math.min(
      this.cursorValue,
      Math.max(0, this.ranked.length - 1),
    )
  }
}

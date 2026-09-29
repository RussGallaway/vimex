const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
})

const ELLIPSIS = "…"

function cellWidth(value: string): number {
  return Bun.stringWidth(value)
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment)
}

function takePrefix(value: string[], width: number): string {
  let result = ""
  let used = 0
  for (const grapheme of value) {
    const next = cellWidth(grapheme)
    if (used + next > width) break
    result += grapheme
    used += next
  }
  return result
}

function takeSuffix(value: string[], width: number): string {
  let result = ""
  let used = 0
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const grapheme = value[index]!
    const next = cellWidth(grapheme)
    if (used + next > width) break
    result = grapheme + result
    used += next
  }
  return result
}

/**
 * Fits a picker path to terminal cells while keeping the useful side visible.
 *
 * With no meaningful query, the beginning of the path is kept because it
 * identifies the workspace or directory. While filtering, the filename and
 * trailing path are more useful, so the beginning is elided instead.
 */
export function formatPickerPath(
  path: string,
  maxWidth: number,
  query = "",
): string {
  const width = Number.isFinite(maxWidth)
    ? Math.max(0, Math.floor(maxWidth))
    : 0
  if (width === 0) return ""
  if (cellWidth(path) <= width) return path

  const ellipsisWidth = cellWidth(ELLIPSIS)
  if (width <= ellipsisWidth) return takePrefix([ELLIPSIS], width)

  const pathGraphemes = graphemes(path)
  const remainingWidth = width - ellipsisWidth
  const hasQuery = query.trim().length > 0

  return hasQuery
    ? `${ELLIPSIS}${takeSuffix(pathGraphemes, remainingWidth)}`
    : `${takePrefix(pathGraphemes, remainingWidth)}${ELLIPSIS}`
}

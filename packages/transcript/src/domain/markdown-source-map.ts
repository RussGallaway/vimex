import type { SourceSpan, TextProjection } from "./transcript-document"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export const graphemes = (value: string): string[] => [...segmenter.segment(value)].map(({ segment }) => segment)
export const graphemeCount = (value: string): number => [...segmenter.segment(value)].length

interface ProjectionBuilder {
  plain: string
  regions: { from: number; to: number; sourceFrom: number; sourceTo: number }[]
  charSpans: SourceSpan[]
  links: { fromCodeUnit: number; toCodeUnit: number; url: string }[]
}

interface SourceLine {
  readonly from: number
  readonly to: number
  readonly newlineTo: number
  readonly value: string
}

function emit(builder: ProjectionBuilder, source: string, from: number, to: number): void {
  const value = source.slice(from, to)
  builder.plain += value
  for (let offset = 0; offset < value.length; offset++) {
    builder.charSpans.push({ from: from + offset, to: from + offset + 1 })
  }
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++
  return slashes % 2 === 1
}

function findClosing(source: string, open: number, token: string, limit: number): number {
  let cursor = open + token.length
  while (cursor < limit) {
    const found = source.indexOf(token, cursor)
    if (found < 0 || found >= limit) return -1
    if (!isEscaped(source, found)) return found
    cursor = found + token.length
  }
  return -1
}

function findBalanced(source: string, open: number, opening: string, closing: string, limit: number): number {
  let depth = 0
  for (let cursor = open; cursor < limit; cursor++) {
    if (isEscaped(source, cursor)) continue
    if (source[cursor] === opening) depth++
    if (source[cursor] === closing && --depth === 0) return cursor
  }
  return -1
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
}

function linkDestination(source: string, open: number, close: number): string | undefined {
  let cursor = open + 1
  while (cursor < close && /\s/.test(source[cursor]!)) cursor++
  if (source[cursor] === "<") {
    const end = source.indexOf(">", cursor + 1)
    if (end < 0 || end >= close) return undefined
    return unescapeMarkdown(source.slice(cursor + 1, end))
  }
  const start = cursor
  let depth = 0
  while (cursor < close) {
    const character = source[cursor]!
    if (character === "\\" && cursor + 1 < close) {
      cursor += 2
      continue
    }
    if (/\s/.test(character) && depth === 0) break
    if (character === "(") depth++
    if (character === ")") {
      if (depth === 0) break
      depth--
    }
    cursor++
  }
  return cursor > start ? unescapeMarkdown(source.slice(start, cursor)) : undefined
}

function bareUrl(source: string, from: number, to: number): string | undefined {
  const candidate = /^(?:https?|file):\/\/[^\s<>]+/.exec(source.slice(from, to))?.[0]
  if (!candidate) return undefined
  let end = candidate.length
  while (end > 0 && /[.,;:!?"']/.test(candidate[end - 1]!)) end--
  const pairs: readonly [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"]]
  let changed = true
  while (changed && end > 0) {
    changed = false
    for (const [opening, closing] of pairs) {
      if (candidate[end - 1] !== closing) continue
      const body = candidate.slice(0, end)
      if (body.split(closing).length > body.split(opening).length) {
        end--
        changed = true
      }
    }
  }
  return candidate.slice(0, end)
}

function projectInline(source: string, from: number, to: number, builder: ProjectionBuilder): void {
  let index = from
  while (index < to) {
    if (source[index] === "\\" && index + 1 < to) {
      emit(builder, source, index + 1, index + 2)
      index += 2
      continue
    }

    const image = source.startsWith("![", index)
    if (image || source[index] === "[") {
      const labelOpen = index + (image ? 1 : 0)
      const labelEnd = findBalanced(source, labelOpen, "[", "]", to)
      let destinationOpen = labelEnd + 1
      while (destinationOpen < to && /[ \t]/.test(source[destinationOpen]!)) destinationOpen++
      if (labelEnd >= 0 && source[destinationOpen] === "(") {
        const targetEnd = findBalanced(source, destinationOpen, "(", ")", to)
        const url = targetEnd >= 0 ? linkDestination(source, destinationOpen, targetEnd) : undefined
        if (targetEnd >= 0 && url !== undefined) {
          const plainFrom = builder.plain.length
          projectInline(source, labelOpen + 1, labelEnd, builder)
          if (!image && /^(https?|file):\/\//.test(url)) {
            builder.links.push({ fromCodeUnit: plainFrom, toCodeUnit: builder.plain.length, url })
          }
          builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: index, sourceTo: targetEnd + 1 })
          index = targetEnd + 1
          continue
        }
      }
    }

    if (source[index] === "<") {
      const end = findClosing(source, index, ">", to)
      const url = end > index ? source.slice(index + 1, end) : ""
      if (end < to && /^(https?|file):\/\//.test(url)) {
        const plainFrom = builder.plain.length
        emit(builder, source, index + 1, end)
        builder.links.push({ fromCodeUnit: plainFrom, toCodeUnit: builder.plain.length, url })
        builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: index, sourceTo: end + 1 })
        index = end + 1
        continue
      }
    }

    if (source[index] === "`") {
      let width = 1
      while (source[index + width] === "`") width++
      const token = "`".repeat(width)
      const end = findClosing(source, index, token, to)
      if (end >= 0) {
        const plainFrom = builder.plain.length
        emit(builder, source, index + width, end)
        builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: index, sourceTo: end + width })
        index = end + width
        continue
      }
    }

    const emphasis = ["**", "__", "~~", "*", "_"].find((token) => source.startsWith(token, index))
    if (emphasis) {
      const end = findClosing(source, index, emphasis, to)
      if (end >= 0) {
        const plainFrom = builder.plain.length
        projectInline(source, index + emphasis.length, end, builder)
        builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: index, sourceTo: end + emphasis.length })
        index = end + emphasis.length
        continue
      }
    }

    const bare = bareUrl(source, index, to)
    if (bare) {
      const plainFrom = builder.plain.length
      emit(builder, source, index, index + bare.length)
      builder.links.push({ fromCodeUnit: plainFrom, toCodeUnit: builder.plain.length, url: bare })
      index += bare.length
      continue
    }

    const width = (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
    emit(builder, source, index, index + width)
    index += width
  }
}

function linesOf(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let from = 0
  while (from < source.length) {
    const newline = source.indexOf("\n", from)
    const to = newline < 0 ? source.length : newline
    lines.push({ from, to, newlineTo: newline < 0 ? to : newline + 1, value: source.slice(from, to) })
    from = newline < 0 ? source.length : newline + 1
  }
  return lines
}

function blockPrefixWidth(line: string): number {
  let width = 0
  while (width < line.length) {
    const container = /^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])[ \t]+)/.exec(line.slice(width))?.[0]
    if (!container) break
    width += container.length
  }
  width += /^(?: {0,3}#{1,6}[ \t]+)/.exec(line.slice(width))?.[0].length ?? 0
  return width
}

function hasTablePipe(line: string): boolean {
  return /(^|[^\\])\|/.test(line)
}

function tableDelimiter(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  const cells = trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim())
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function projectLine(source: string, line: SourceLine, builder: ProjectionBuilder): void {
  const prefix = blockPrefixWidth(line.value)
  const plainFrom = builder.plain.length
  projectInline(source, line.from + prefix, line.to, builder)
  if (prefix) builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: line.from, sourceTo: line.to })
  if (line.newlineTo > line.to) emit(builder, source, line.to, line.newlineTo)
}

/** Deterministic CommonMark-oriented projection with an exact rendered-grapheme to source map. */
export function projectMarkdown(source: string): Omit<TextProjection, "revision"> {
  const builder: ProjectionBuilder = { plain: "", charSpans: [], links: [], regions: [] }
  const lines = linesOf(source)
  let fence: { marker: "`" | "~"; width: number; sourceFrom: number; plainFrom: number; plainTo: number } | undefined

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!
    if (fence) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line.value)
      if (close?.[2]?.[0] === fence.marker && close[2].length >= fence.width) {
        builder.regions.push({ from: fence.plainFrom, to: fence.plainTo, sourceFrom: fence.sourceFrom, sourceTo: line.to })
        fence = undefined
      } else {
        emit(builder, source, line.from, line.to)
        fence.plainTo = builder.plain.length
        if (line.newlineTo > line.to) emit(builder, source, line.to, line.newlineTo)
      }
      continue
    }

    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.value)
    if (open?.[2] && !(open[2][0] === "`" && open[3]?.includes("`"))) {
      fence = {
        marker: open[2][0] as "`" | "~",
        width: open[2].length,
        sourceFrom: line.from,
        plainFrom: builder.plain.length,
        plainTo: builder.plain.length,
      }
      continue
    }

    const delimiter = lines[lineIndex + 1]
    if (delimiter && hasTablePipe(line.value) && tableDelimiter(delimiter.value)) {
      const sourceFrom = line.from
      const plainFrom = builder.plain.length
      projectLine(source, line, builder)
      lineIndex++
      let sourceTo = delimiter.to
      while (lines[lineIndex + 1] && hasTablePipe(lines[lineIndex + 1]!.value) && lines[lineIndex + 1]!.value.trim() !== "") {
        const body = lines[++lineIndex]!
        projectLine(source, body, builder)
        sourceTo = body.to
      }
      const plainTo = builder.plain.endsWith("\n") ? builder.plain.length - 1 : builder.plain.length
      builder.regions.push({ from: plainFrom, to: plainTo, sourceFrom, sourceTo })
      continue
    }

    projectLine(source, line, builder)
  }

  if (fence) {
    builder.regions.push({ from: fence.plainFrom, to: fence.plainTo, sourceFrom: fence.sourceFrom, sourceTo: source.length })
  }

  const sourceSpans: SourceSpan[] = []
  const graphemeStarts: number[] = []
  for (const part of segmenter.segment(builder.plain)) {
    graphemeStarts.push(part.index)
    const last = part.index + part.segment.length - 1
    sourceSpans.push({
      from: builder.charSpans[part.index]?.from ?? source.length,
      to: builder.charSpans[last]?.to ?? source.length,
    })
  }
  // Convert every region/link boundary against the one segmentation above.
  // Re-segmenting each prefix makes long formatted responses quadratic.
  const toGrapheme = (codeUnit: number): number => {
    let low = 0
    let high = graphemeStarts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (graphemeStarts[middle]! < codeUnit) low = middle + 1
      else high = middle
    }
    return low
  }
  return {
    plain: builder.plain,
    source,
    sourceSpans,
    sourceRegions: builder.regions.map((region) => ({ ...region, from: toGrapheme(region.from), to: toGrapheme(region.to) })),
    links: builder.links.map((link) => ({ from: toGrapheme(link.fromCodeUnit), to: toGrapheme(link.toCodeUnit), url: link.url })),
  }
}

/** Tool output and patches are literal text, even when they contain Markdown syntax. */
export function projectPlainText(source: string): Omit<TextProjection, "revision"> {
  const sourceSpans: SourceSpan[] = []
  for (const part of segmenter.segment(source)) {
    sourceSpans.push({ from: part.index, to: part.index + part.segment.length })
  }
  const offsetAt = (codeUnit: number): number => {
    let low = 0, high = sourceSpans.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (sourceSpans[middle]!.from < codeUnit) low = middle + 1
      else high = middle
    }
    return low
  }
  const links: TextProjection["links"][number][] = []
  for (const match of source.matchAll(/(?:https?|file):\/\//g)) {
    const url = bareUrl(source, match.index, source.length)
    if (url) links.push({ from: offsetAt(match.index), to: offsetAt(match.index + url.length), url })
  }
  return { plain: source, source, sourceSpans, sourceRegions: [], links }
}

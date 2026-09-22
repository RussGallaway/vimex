import type { SourceSpan, TextProjection } from "./transcript-document"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export const graphemes = (value: string): string[] =>
  [...segmenter.segment(value)].map(({ segment }) => segment)
export const graphemeCount = (value: string): number =>
  [...segmenter.segment(value)].length

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

interface ReferenceDefinition {
  readonly url: string
}

type ReferenceMap = ReadonlyMap<string, ReferenceDefinition>

function emit(
  builder: ProjectionBuilder,
  source: string,
  from: number,
  to: number,
): void {
  const value = source.slice(from, to)
  builder.plain += value
  for (let offset = 0; offset < value.length; offset++) {
    builder.charSpans.push({ from: from + offset, to: from + offset + 1 })
  }
}

function emitMapped(
  builder: ProjectionBuilder,
  value: string,
  from: number,
  to: number,
): void {
  builder.plain += value
  for (let offset = 0; offset < value.length; offset++)
    builder.charSpans.push({ from, to })
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--)
    slashes++
  return slashes % 2 === 1
}

function findClosing(
  source: string,
  open: number,
  token: string,
  limit: number,
): number {
  let cursor = open + token.length
  while (cursor < limit) {
    const found = source.indexOf(token, cursor)
    if (found < 0 || found >= limit) return -1
    if (!isEscaped(source, found)) return found
    cursor = found + token.length
  }
  return -1
}

function findClosingCodeRun(
  source: string,
  open: number,
  width: number,
  limit: number,
): number {
  let cursor = open + width
  while (cursor < limit) {
    const found = source.indexOf("`", cursor)
    if (found < 0 || found >= limit) return -1
    let runWidth = 1
    while (source[found + runWidth] === "`") runWidth++
    if (runWidth === width) return found
    cursor = found + runWidth
  }
  return -1
}

function findBalanced(
  source: string,
  open: number,
  opening: string,
  closing: string,
  limit: number,
): number {
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

function normalizeReferenceLabel(value: string): string {
  return unescapeMarkdown(value).trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

function definitionTitle(value: string): boolean {
  return /^(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/.test(value.trim())
}

function definitionDestination(
  value: string,
): { url: string; rest: string } | undefined {
  const trimmed = value.trimStart()
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">", 1)
    if (end < 0) return undefined
    return { url: trimmed.slice(1, end), rest: trimmed.slice(end + 1) }
  }
  let cursor = 0
  let depth = 0
  while (cursor < trimmed.length) {
    const character = trimmed[cursor]!
    if (character === "\\" && cursor + 1 < trimmed.length) {
      cursor += 2
      continue
    }
    if (/\s/.test(character) && depth === 0) break
    if (character === "(") depth++
    if (character === ")" && --depth < 0) return undefined
    cursor++
  }
  return cursor > 0 && depth === 0
    ? { url: trimmed.slice(0, cursor), rest: trimmed.slice(cursor) }
    : undefined
}

function referenceDefinitions(lines: readonly SourceLine[]): {
  definitions: Map<string, ReferenceDefinition>
  lines: Set<number>
} {
  const definitions = new Map<string, ReferenceDefinition>()
  const definitionLines = new Set<number>()
  let fence: { marker: "`" | "~"; width: number } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const definitionStart = index
    if (fence) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line.value)
      if (close?.[2]?.[0] === fence.marker && close[2].length >= fence.width)
        fence = undefined
      continue
    }
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.value)
    if (open?.[2] && !(open[2][0] === "`" && open[3]?.includes("`"))) {
      fence = { marker: open[2][0] as "`" | "~", width: open[2].length }
      continue
    }
    const match = /^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line.value)
    const label = match?.[1]
    if (!label) continue
    let destinationLine = index
    let destinationText = match[2]!
    if (!destinationText.trim()) {
      const continuation = lines[index + 1]
      if (!continuation || !/^ {0,3}\S/.test(continuation.value)) continue
      destinationLine = index + 1
      destinationText = continuation.value
    }
    const destination = definitionDestination(destinationText)
    if (
      !destination ||
      (destination.rest.trim() && !definitionTitle(destination.rest))
    )
      continue
    let finalLine = destinationLine
    if (
      !destination.rest.trim() &&
      lines[destinationLine + 1] &&
      /^ {0,3}(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/.test(
        lines[destinationLine + 1]!.value,
      )
    ) {
      finalLine = destinationLine + 1
    }
    const normalized = normalizeReferenceLabel(label)
    if (!definitions.has(normalized))
      definitions.set(normalized, { url: unescapeMarkdown(destination.url) })
    for (let consumed = definitionStart; consumed <= finalLine; consumed++)
      definitionLines.add(lines[consumed]!.from)
    index = finalLine
  }
  return { definitions, lines: definitionLines }
}

function linkDestination(
  source: string,
  open: number,
  close: number,
): string | undefined {
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
  return cursor > start
    ? unescapeMarkdown(source.slice(start, cursor))
    : undefined
}

function bareUrl(source: string, from: number, to: number): string | undefined {
  const candidate = /^(?:https?|file):\/\/[^\s<>]+/.exec(
    source.slice(from, to),
  )?.[0]
  if (!candidate) return undefined
  let end = candidate.length
  while (end > 0 && /[.,;:!?"']/.test(candidate[end - 1]!)) end--
  const pairs: readonly [string, string][] = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]
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

function emitCodeSpan(
  builder: ProjectionBuilder,
  source: string,
  from: number,
  to: number,
): void {
  const pieces: { value: string; from: number; to: number }[] = []
  let cursor = from
  while (cursor < to) {
    if (source[cursor] === "\r" || source[cursor] === "\n") {
      const width =
        source[cursor] === "\r" && source[cursor + 1] === "\n" ? 2 : 1
      pieces.push({ value: " ", from: cursor, to: cursor + width })
      cursor += width
      continue
    }
    const width = (source.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1
    pieces.push({
      value: source.slice(cursor, cursor + width),
      from: cursor,
      to: cursor + width,
    })
    cursor += width
  }
  const hasNonSpace = pieces.some((piece) => piece.value !== " ")
  const normalized =
    hasNonSpace && pieces[0]?.value === " " && pieces.at(-1)?.value === " "
      ? pieces.slice(1, -1)
      : pieces
  for (const piece of normalized)
    emitMapped(builder, piece.value, piece.from, piece.to)
}

function projectInline(
  source: string,
  from: number,
  to: number,
  builder: ProjectionBuilder,
  references: ReferenceMap,
): void {
  let index = from
  while (index < to) {
    if (
      source[index] === "\\" &&
      index + 1 < to &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(source[index + 1]!)
    ) {
      emit(builder, source, index + 1, index + 2)
      index += 2
      continue
    }

    const image = source.startsWith("![", index)
    if (image || source[index] === "[") {
      const labelOpen = index + (image ? 1 : 0)
      const labelEnd = findBalanced(source, labelOpen, "[", "]", to)
      let destinationOpen = labelEnd + 1
      while (destinationOpen < to && /[ \t]/.test(source[destinationOpen]!))
        destinationOpen++
      if (labelEnd >= 0 && source[destinationOpen] === "(") {
        const targetEnd = findBalanced(source, destinationOpen, "(", ")", to)
        const url =
          targetEnd >= 0
            ? linkDestination(source, destinationOpen, targetEnd)
            : undefined
        if (targetEnd >= 0 && url !== undefined) {
          const plainFrom = builder.plain.length
          projectInline(source, labelOpen + 1, labelEnd, builder, references)
          if (!image && /^(https?|file):\/\//.test(url)) {
            builder.links.push({
              fromCodeUnit: plainFrom,
              toCodeUnit: builder.plain.length,
              url,
            })
          }
          builder.regions.push({
            from: plainFrom,
            to: builder.plain.length,
            sourceFrom: index,
            sourceTo: targetEnd + 1,
          })
          index = targetEnd + 1
          continue
        }
      }
      if (labelEnd >= 0) {
        let syntaxEnd = labelEnd + 1
        let referenceLabel = source.slice(labelOpen + 1, labelEnd)
        if (source[syntaxEnd] === "[") {
          const referenceEnd = findBalanced(source, syntaxEnd, "[", "]", to)
          if (referenceEnd >= 0) {
            referenceLabel =
              source.slice(syntaxEnd + 1, referenceEnd) || referenceLabel
            syntaxEnd = referenceEnd + 1
          }
        }
        const reference = references.get(
          normalizeReferenceLabel(referenceLabel),
        )
        if (reference) {
          const plainFrom = builder.plain.length
          projectInline(source, labelOpen + 1, labelEnd, builder, references)
          if (!image && /^(https?|file):\/\//.test(reference.url)) {
            builder.links.push({
              fromCodeUnit: plainFrom,
              toCodeUnit: builder.plain.length,
              url: reference.url,
            })
          }
          builder.regions.push({
            from: plainFrom,
            to: builder.plain.length,
            sourceFrom: index,
            sourceTo: syntaxEnd,
          })
          index = syntaxEnd
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
        builder.links.push({
          fromCodeUnit: plainFrom,
          toCodeUnit: builder.plain.length,
          url,
        })
        builder.regions.push({
          from: plainFrom,
          to: builder.plain.length,
          sourceFrom: index,
          sourceTo: end + 1,
        })
        index = end + 1
        continue
      }
    }

    if (source[index] === "`") {
      let width = 1
      while (source[index + width] === "`") width++
      const token = "`".repeat(width)
      const end = findClosingCodeRun(source, index, width, to)
      if (end >= 0) {
        const plainFrom = builder.plain.length
        emitCodeSpan(builder, source, index + width, end)
        builder.regions.push({
          from: plainFrom,
          to: builder.plain.length,
          sourceFrom: index,
          sourceTo: end + width,
        })
        index = end + width
        continue
      }
    }

    const emphasis = ["***", "___", "**", "__", "~~", "*", "_"].find((token) =>
      source.startsWith(token, index),
    )
    if (emphasis) {
      const intrawordUnderscore =
        emphasis.includes("_") &&
        /[\p{L}\p{N}]/u.test(source[index - 1] ?? "") &&
        /[\p{L}\p{N}]/u.test(source[index + emphasis.length] ?? "")
      const end = intrawordUnderscore
        ? -1
        : findClosing(source, index, emphasis, to)
      if (end >= 0) {
        const plainFrom = builder.plain.length
        projectInline(source, index + emphasis.length, end, builder, references)
        builder.regions.push({
          from: plainFrom,
          to: builder.plain.length,
          sourceFrom: index,
          sourceTo: end + emphasis.length,
        })
        index = end + emphasis.length
        continue
      }
    }

    const bare = bareUrl(source, index, to)
    if (bare) {
      const plainFrom = builder.plain.length
      emit(builder, source, index, index + bare.length)
      builder.links.push({
        fromCodeUnit: plainFrom,
        toCodeUnit: builder.plain.length,
        url: bare,
      })
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
    lines.push({
      from,
      to,
      newlineTo: newline < 0 ? to : newline + 1,
      value: source.slice(from, to),
    })
    from = newline < 0 ? source.length : newline + 1
  }
  return lines
}

function blockPrefixWidth(line: string): number {
  let width = 0
  while (width < line.length) {
    const container = /^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])[ \t]+)/.exec(
      line.slice(width),
    )?.[0]
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

function thematicBreak(line: string): boolean {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
    line,
  )
}

function projectLine(
  source: string,
  line: SourceLine,
  builder: ProjectionBuilder,
  references: ReferenceMap,
): void {
  const prefix = blockPrefixWidth(line.value)
  const plainFrom = builder.plain.length
  projectInline(source, line.from + prefix, line.to, builder, references)
  if (prefix)
    builder.regions.push({
      from: plainFrom,
      to: builder.plain.length,
      sourceFrom: line.from,
      sourceTo: line.to,
    })
  if (line.newlineTo > line.to) emit(builder, source, line.to, line.newlineTo)
}

function multilineCodeParagraphEnd(
  source: string,
  lines: readonly SourceLine[],
  start: number,
  definitionLines: ReadonlySet<number>,
): number {
  const first = lines[start]!
  if (blockPrefixWidth(first.value) !== 0 || !first.value.includes("`"))
    return start
  const openRuns: { from: number; width: number }[] = []
  for (let cursor = first.from; cursor < first.to;) {
    if (source[cursor] !== "`") {
      cursor++
      continue
    }
    let width = 1
    while (source[cursor + width] === "`") width++
    if (isEscaped(source, cursor)) {
      cursor += width
      continue
    }
    const sameLineClose = findClosingCodeRun(source, cursor, width, first.to)
    if (sameLineClose < 0) openRuns.push({ from: cursor, width })
    cursor = sameLineClose < 0 ? cursor + width : sameLineClose + width
  }
  if (openRuns.length === 0) return start
  let end = start
  while (end + 1 < lines.length) {
    const next = lines[end + 1]!
    if (!next.value.trim() || definitionLines.has(next.from)) break
    if (
      /^ {0,3}(?:#{1,6}[ \t]+|>|(?:[-+*]|\d+[.)])[ \t]+|`{3,}|~{3,})/.test(
        next.value,
      )
    )
      break
    end++
  }
  if (end === start) return start
  for (const opener of openRuns) {
    const close = findClosingCodeRun(
      source,
      opener.from,
      opener.width,
      lines[end]!.to,
    )
    if (close > first.to) return end
  }
  return start
}

/** Deterministic CommonMark-oriented projection with an exact rendered-grapheme to source map. */
export function projectMarkdown(
  source: string,
): Omit<TextProjection, "revision" | "nodeKind"> {
  const builder: ProjectionBuilder = {
    plain: "",
    charSpans: [],
    links: [],
    regions: [],
  }
  const lines = linesOf(source)
  const references = referenceDefinitions(lines)
  let fence:
    | {
        marker: "`" | "~"
        width: number
        sourceFrom: number
        plainFrom: number
        plainTo: number
      }
    | undefined

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!
    if (fence) {
      const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line.value)
      if (close?.[2]?.[0] === fence.marker && close[2].length >= fence.width) {
        builder.regions.push({
          from: fence.plainFrom,
          to: fence.plainTo,
          sourceFrom: fence.sourceFrom,
          sourceTo: line.to,
        })
        fence = undefined
      } else {
        emit(builder, source, line.from, line.to)
        fence.plainTo = builder.plain.length
        if (line.newlineTo > line.to)
          emit(builder, source, line.to, line.newlineTo)
      }
      continue
    }

    if (references.lines.has(line.from)) continue

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

    const paragraphEnd = multilineCodeParagraphEnd(
      source,
      lines,
      lineIndex,
      references.lines,
    )
    if (paragraphEnd > lineIndex) {
      const finalLine = lines[paragraphEnd]!
      projectInline(
        source,
        line.from,
        finalLine.to,
        builder,
        references.definitions,
      )
      if (finalLine.newlineTo > finalLine.to)
        emit(builder, source, finalLine.to, finalLine.newlineTo)
      lineIndex = paragraphEnd
      continue
    }

    const previousLine = lines[lineIndex - 1]
    const hyphenSetextUnderline =
      /^ {0,3}-{3,}[ \t]*$/.test(line.value) &&
      !!previousLine?.value.trim() &&
      blockPrefixWidth(previousLine.value) === 0
    if (thematicBreak(line.value) && !hyphenSetextUnderline) {
      emitMapped(builder, "─", line.from, line.to)
      if (line.newlineTo > line.to)
        emit(builder, source, line.to, line.newlineTo)
      continue
    }

    const delimiter = lines[lineIndex + 1]
    if (
      delimiter &&
      hasTablePipe(line.value) &&
      tableDelimiter(delimiter.value)
    ) {
      const sourceFrom = line.from
      const plainFrom = builder.plain.length
      projectLine(source, line, builder, references.definitions)
      lineIndex++
      let sourceTo = delimiter.to
      while (
        lines[lineIndex + 1] &&
        hasTablePipe(lines[lineIndex + 1]!.value) &&
        lines[lineIndex + 1]!.value.trim() !== ""
      ) {
        const body = lines[++lineIndex]!
        projectLine(source, body, builder, references.definitions)
        sourceTo = body.to
      }
      const plainTo = builder.plain.endsWith("\n")
        ? builder.plain.length - 1
        : builder.plain.length
      builder.regions.push({
        from: plainFrom,
        to: plainTo,
        sourceFrom,
        sourceTo,
      })
      continue
    }

    projectLine(source, line, builder, references.definitions)
  }

  if (fence) {
    builder.regions.push({
      from: fence.plainFrom,
      to: fence.plainTo,
      sourceFrom: fence.sourceFrom,
      sourceTo: source.length,
    })
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
    sourceRegions: builder.regions.map((region) => ({
      ...region,
      from: toGrapheme(region.from),
      to: toGrapheme(region.to),
    })),
    links: builder.links.map((link) => ({
      from: toGrapheme(link.fromCodeUnit),
      to: toGrapheme(link.toCodeUnit),
      url: link.url,
    })),
  }
}

/** Tool output and patches are literal text, even when they contain Markdown syntax. */
export function projectPlainText(
  source: string,
): Omit<TextProjection, "revision" | "nodeKind"> {
  const sourceSpans: SourceSpan[] = []
  for (const part of segmenter.segment(source)) {
    sourceSpans.push({ from: part.index, to: part.index + part.segment.length })
  }
  const offsetAt = (codeUnit: number): number => {
    let low = 0,
      high = sourceSpans.length
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
    if (url)
      links.push({
        from: offsetAt(match.index),
        to: offsetAt(match.index + url.length),
        url,
      })
  }
  return { plain: source, source, sourceSpans, sourceRegions: [], links }
}

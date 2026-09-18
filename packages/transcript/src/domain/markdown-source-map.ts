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

function emit(builder: ProjectionBuilder, source: string, from: number, to: number): void {
  const value = source.slice(from, to)
  builder.plain += value
  for (let offset = 0; offset < value.length; offset++) builder.charSpans.push({ from: from + offset, to: from + offset + 1 })
}
function findClosing(source: string, open: number, token: string, limit: number): number {
  const found = source.indexOf(token, open + token.length)
  return found >= 0 && found < limit ? found : -1
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
      const labelFrom = index + (image ? 2 : 1)
      const labelEnd = source.indexOf("](", labelFrom)
      const targetEnd = labelEnd >= 0 ? source.indexOf(")", labelEnd + 2) : -1
      if (labelEnd >= 0 && targetEnd >= 0 && targetEnd < to) {
        const plainFrom = builder.plain.length
        projectInline(source, labelFrom, labelEnd, builder)
        const url = source.slice(labelEnd + 2, targetEnd).trim()
        if (!image && /^(https?|file):\/\//.test(url)) {
          builder.links.push({ fromCodeUnit: plainFrom, toCodeUnit: builder.plain.length, url })
        }
        builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: index, sourceTo: targetEnd + 1 })
        index = targetEnd + 1
        continue
      }
    }
    if (source[index] === "<") {
      const end = source.indexOf(">", index + 1)
      const url = end > index ? source.slice(index + 1, end) : ""
      if (end < to && /^(https?|file):\/\//.test(url)) {
        const plainFrom = builder.plain.length
        emit(builder, source, index + 1, end)
        builder.links.push({ fromCodeUnit: plainFrom, toCodeUnit: builder.plain.length, url })
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
    const bare = /^(https?:\/\/[^\s)<]+)/.exec(source.slice(index, to))?.[1]
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

/** Deterministic Markdown projection with an exact rendered-grapheme to source map. */
export function projectMarkdown(source: string): Omit<TextProjection, "revision"> {
  const builder: ProjectionBuilder = { plain: "", charSpans: [], links: [], regions: [] }
  let offset = 0
  let fence: string | undefined
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset)
    const end = newline < 0 ? source.length : newline
    const line = source.slice(offset, end)
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = undefined
    } else if (fence) {
      emit(builder, source, offset, end)
      if (newline >= 0) emit(builder, source, newline, newline + 1)
    } else {
      const prefix = /^(?:\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+))/.exec(line)?.[0].length ?? 0
      const plainFrom = builder.plain.length
      projectInline(source, offset + prefix, end, builder)
      if (prefix) builder.regions.push({ from: plainFrom, to: builder.plain.length, sourceFrom: offset, sourceTo: end })
      if (newline >= 0) emit(builder, source, newline, newline + 1)
    }
    offset = newline < 0 ? source.length : newline + 1
  }
  const sourceSpans: SourceSpan[] = []
  for (const part of segmenter.segment(builder.plain)) {
    const last = part.index + part.segment.length - 1
    sourceSpans.push({
      from: builder.charSpans[part.index]?.from ?? source.length,
      to: builder.charSpans[last]?.to ?? source.length,
    })
  }
  const toGrapheme = (codeUnit: number) => graphemeCount(builder.plain.slice(0, codeUnit))
  return {
    plain: builder.plain,
    source,
    sourceSpans,
    sourceRegions: builder.regions.map(region => ({ ...region, from: toGrapheme(region.from), to: toGrapheme(region.to) })),
    links: builder.links.map((link) => ({ from: toGrapheme(link.fromCodeUnit), to: toGrapheme(link.toCodeUnit), url: link.url })),
  }
}

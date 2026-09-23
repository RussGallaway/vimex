const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function cellWidth(grapheme: string): number {
  // OpenTUI offsets count terminal columns, including one for a newline.
  return Math.max(1, Bun.stringWidth(grapheme))
}

export function graphemeOffsetToNativeOffset(
  text: string,
  graphemeOffset: number,
): number {
  let offset = 0
  let index = 0
  for (const { segment } of segmenter.segment(text)) {
    if (index++ >= graphemeOffset) break
    offset += cellWidth(segment)
  }
  return offset
}

export function nativeOffsetToGraphemeOffset(
  text: string,
  nativeOffset: number,
): number {
  let offset = 0
  let index = 0
  for (const { segment } of segmenter.segment(text)) {
    const next = offset + cellWidth(segment)
    if (next > nativeOffset) break
    offset = next
    index++
  }
  return index
}

export function codeUnitOffsetToNativeOffset(
  text: string,
  codeUnitOffset: number,
): number {
  return graphemeOffsetToNativeOffset(
    text,
    [...segmenter.segment(text.slice(0, codeUnitOffset))].length,
  )
}

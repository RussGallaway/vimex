import type { ComposerState } from "./composer-state"
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemeCount = (value: string) => [...segmenter.segment(value)].length
export function updateDraft(
  state: ComposerState,
  text: string,
  cursorOffset = graphemeCount(text),
): ComposerState {
  const images = state.images.every(
    (image) => !image.marker || text.includes(image.marker),
  )
    ? state.images
    : state.images.filter(
        (image) => !image.marker || text.includes(image.marker),
      )
  const mentions = state.mentions.filter(
    (mention) => !mention.marker || text.includes(mention.marker),
  )
  return {
    ...state,
    text,
    images,
    mentions,
    cursorOffset: Math.max(0, Math.min(cursorOffset, graphemeCount(text))),
    revision: state.revision + 1,
  }
}

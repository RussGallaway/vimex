import type { ComposerState } from "./composer-state"
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemeCount = (value: string) => [...segmenter.segment(value)].length
export function updateDraft(
  state: ComposerState,
  text: string,
  cursorOffset = graphemeCount(text),
): ComposerState {
  return {
    ...state,
    text,
    cursorOffset: Math.max(0, Math.min(cursorOffset, graphemeCount(text))),
    revision: state.revision + 1,
  }
}

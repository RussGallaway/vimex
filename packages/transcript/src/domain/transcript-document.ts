import type { ItemId } from "@vimex/conversation"

export interface LinkTarget { from: number; to: number; url: string }
export interface SourceSpan { from: number; to: number }
export interface TextProjection {
  plain: string
  source: string
  /** One exact source span for each rendered grapheme. */
  sourceSpans: readonly SourceSpan[]
  links: readonly LinkTarget[]
  /** Syntax envelopes included when their entire rendered content is selected. */
  sourceRegions?: readonly { from: number; to: number; sourceFrom: number; sourceTo: number }[]
  revision: number
}
export interface LogicalPoint { itemId: ItemId; graphemeOffset: number }
export type ViewportAnchor =
  | { kind: "tail" }
  | { kind: "point"; point: LogicalPoint; preferredScreenRow: number }
export interface TranscriptSelection {
  anchor: LogicalPoint
  head: LogicalPoint
  shape: "character" | "line"
}
export interface TranscriptState {
  search?: { query: string; direction: "forward" | "backward" }
  order: readonly ItemId[]
  projectionById: Readonly<Record<string, TextProjection>>
  cursor?: LogicalPoint
  selection?: TranscriptSelection
  folded: Readonly<Record<string, true>>
  viewport: ViewportAnchor
  unseenEntries: number
}
export type TranscriptCommand =
  | { type: "search.set"; query: string; direction: "forward" | "backward" }
  | { type: "cursor.move"; point: LogicalPoint; preferredScreenRow?: number }
  | { type: "tail.attach" }
  | { type: "selection.begin"; shape: TranscriptSelection["shape"] }
  | { type: "selection.swap" }
  | { type: "selection.clear" }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.toggle"; itemId: ItemId }
  | { type: "fold.all"; folded: boolean }

export const initialTranscript = (): TranscriptState => ({
  order: [], projectionById: {}, folded: {}, viewport: { kind: "tail" }, unseenEntries: 0,
})

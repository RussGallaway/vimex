import type { ItemId } from "@vimex/conversation"

export interface LinkTarget { from: number; to: number; url: string }
export interface SourceSpan { from: number; to: number }
export interface TextProjection {
  /** Semantic node class used by message-wise navigation. */
  nodeKind?: "message" | "reasoning" | "tool" | "edit" | "unknown"
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
export interface JumpLocation { point: LogicalPoint; preferredScreenRow: number }
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
  folded: Readonly<Record<string, boolean>>
  viewport: ViewportAnchor
  unseenEntries: number
  /** Item ids whose changed output has already contributed to unseenEntries. */
  unseenItemIds: readonly ItemId[]
  jumps: { back: readonly JumpLocation[]; forward: readonly JumpLocation[] }
  marks: Readonly<Record<string, JumpLocation>>
}
export type TranscriptCommand =
  | { type: "search.set"; query: string; direction: "forward" | "backward" }
  | { type: "cursor.move"; point: LogicalPoint; preferredScreenRow?: number }
  | { type: "jump.to"; target: JumpLocation; origin?: JumpLocation }
  | { type: "jump.back"; origin?: JumpLocation }
  | { type: "jump.forward"; origin?: JumpLocation }
  | { type: "mark.set"; name: string; target: JumpLocation }
  | { type: "mark.jump"; name: string; origin?: JumpLocation }
  | { type: "viewport.anchor"; point: LogicalPoint; preferredScreenRow: number }
  | { type: "tail.attach" }
  | { type: "selection.begin"; shape: TranscriptSelection["shape"] }
  | { type: "selection.swap" }
  | { type: "selection.clear" }
  | { type: "fold.set"; itemId: ItemId; folded: boolean }
  | { type: "fold.toggle"; itemId: ItemId }
  | { type: "fold.all"; folded: boolean }

export const initialTranscript = (): TranscriptState => ({
  order: [], projectionById: {}, folded: {}, viewport: { kind: "tail" }, unseenEntries: 0, unseenItemIds: [], jumps: { back: [], forward: [] }, marks: {},
})

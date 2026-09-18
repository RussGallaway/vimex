import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { ItemId } from "@vimex/conversation"
import type { ComposerState, SubmissionIntent } from "@vimex/composer"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState } from "@vimex/transcript"
import type { MutableRefObject, RefObject } from "react"
import type { VimexUiController } from "../contracts"
import type { movePoint } from "../transcript/layout"

export type Motion = Parameters<typeof movePoint>[2]
export type UiBinding = { key: string; cmd: () => unknown }
export interface VimBindingContext {
  distinctControlI?: boolean
  interaction: InteractionState
  transcript: TranscriptState
  foldableItemIds?: readonly ItemId[]
  composer: ComposerState
  controller: VimexUiController
  countRef: MutableRefObject<string>
  textareaRef: RefObject<TextareaRenderable | null>
  scrollRef: RefObject<ScrollBoxRenderable | null>
  enterVisibleTranscript(): void
  submitComposer(intent: SubmissionIntent): void
  countedMotion(motion: Motion): void
  dispatchMotion(motion: Motion): void
  runComposerKey(key: string): void
  beginVisual(shape: "character" | "line"): void
  openOverlay(overlay: "sessions" | "approvals" | "questions" | "fork" | "agents" | "urls" | "help"): void
  scroll(direction: "up" | "down", amount: "line" | "half-page" | "page"): void
}

export function countBindings(ctx: VimBindingContext): UiBinding[] {
  return Array.from({ length: 9 }, (_, index) => ({ key: `${index + 1}`, cmd: () => {
    ctx.countRef.current = `${ctx.countRef.current}${index + 1}`.slice(0, 4)
    ctx.controller.dispatchInteraction({ type: "count.push", digit: index + 1 })
  } }))
}

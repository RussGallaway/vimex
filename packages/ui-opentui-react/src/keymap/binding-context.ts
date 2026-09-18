import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { ComposerState } from "@vimex/composer"
import type { InteractionState } from "@vimex/interaction"
import type { TranscriptState } from "@vimex/transcript"
import type { MutableRefObject, RefObject } from "react"
import type { VimexUiController } from "../contracts"
import type { movePoint } from "../transcript/layout"

export type Motion = Parameters<typeof movePoint>[2]
export type UiBinding = { key: string; cmd: () => unknown }
export interface VimBindingContext {
  interaction: InteractionState
  transcript: TranscriptState
  composer: ComposerState
  controller: VimexUiController
  countRef: MutableRefObject<string>
  textareaRef: RefObject<TextareaRenderable | null>
  scrollRef: RefObject<ScrollBoxRenderable | null>
  countedMotion(motion: Motion): void
  dispatchMotion(motion: Motion): void
  runComposerKey(key: string): void
  beginVisual(shape: "character" | "line"): void
  openOverlay(overlay: "sessions" | "approvals" | "help"): void
  scroll(direction: "up" | "down", amount: "line" | "half-page"): void
}

export function countBindings(ctx: VimBindingContext): UiBinding[] {
  return Array.from({ length: 9 }, (_, index) => ({ key: `${index + 1}`, cmd: () => {
    ctx.countRef.current = `${ctx.countRef.current}${index + 1}`.slice(0, 4)
    ctx.controller.dispatchInteraction({ type: "count.push", digit: index + 1 })
  } }))
}

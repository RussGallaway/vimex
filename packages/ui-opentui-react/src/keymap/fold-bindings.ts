import type { VimBindingContext } from "./binding-context"

export function toggleCurrentFold(ctx: VimBindingContext): void {
  const id = ctx.transcript.cursor?.itemId
  if (!id || (ctx.foldableItemIds && !ctx.foldableItemIds.includes(id))) return
  ctx.controller.transcript({ type: "fold.set", itemId: id, folded: !ctx.transcript.folded[id] })
}

export function toggleAllFolds(ctx: VimBindingContext): void {
  const ids = ctx.foldableItemIds ?? ctx.transcript.order
  if (!ids.length) return
  const anyCollapsed = ids.some(id => ctx.transcript.folded[id])
  ctx.controller.transcript({ type: "fold.all", folded: !anyCollapsed })
}

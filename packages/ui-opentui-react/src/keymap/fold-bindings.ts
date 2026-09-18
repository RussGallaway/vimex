import type { UiBinding, VimBindingContext } from "./binding-context"

export function setCurrentFold(ctx: VimBindingContext, folded?: boolean): void {
  if (ctx.interaction.surface !== "transcript") return
  const id = ctx.transcript.cursor?.itemId
  if (!id || (ctx.foldableItemIds && !ctx.foldableItemIds.includes(id))) return
  ctx.controller.transcript({ type: "fold.set", itemId: id, folded: folded ?? !ctx.transcript.folded[id] })
}

export function toggleAllFolds(ctx: VimBindingContext): void {
  const ids = ctx.foldableItemIds ?? ctx.transcript.order
  if (!ids.length) return
  const anyCollapsed = ids.some(id => ctx.transcript.folded[id])
  ctx.controller.transcript({ type: "fold.all", folded: !anyCollapsed })
}


export function toggleCurrentFold(ctx: VimBindingContext): void { setCurrentFold(ctx) }

export function vimFoldBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    ...(ctx.interaction.surface === "transcript" ? [
      { key: "za", cmd: () => setCurrentFold(ctx) },
      { key: "zo", cmd: () => setCurrentFold(ctx, false) },
      { key: "zc", cmd: () => setCurrentFold(ctx, true) },
    ] : []),
    { key: "zshift+r", cmd: () => ctx.controller.transcript({ type: "fold.all", folded: false }) },
    { key: "zshift+m", cmd: () => ctx.controller.transcript({ type: "fold.all", folded: true }) },
  ]
}

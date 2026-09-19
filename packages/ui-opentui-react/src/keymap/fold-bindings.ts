import type { UiBinding, VimBindingContext } from "./binding-context"

export function setCurrentFold(ctx: VimBindingContext, folded?: boolean): void {
  if (ctx.interaction.surface !== "transcript") return
  const id = ctx.transcript.cursor?.itemId
  if (!id || ctx.transcript.projectionById[id]?.nodeKind === "message") return
  ctx.controller.transcript({ type: "fold.set", itemId: id, folded: folded ?? !ctx.transcript.folded[id] })
}

export function toggleAllFolds(ctx: VimBindingContext): void {
  const ids = ctx.transcript.order.filter(id => ctx.transcript.projectionById[id]?.nodeKind !== "message")
  if (!ids.length) return
  // Fold-all remains a complete semantic operation; off-window folds decide
  // whether the next toggle opens or closes the complete transcript.
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

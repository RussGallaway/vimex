import type { UiBinding, VimBindingContext } from "./binding-context"

export function setCurrentFold(ctx: VimBindingContext, folded?: boolean): void {
  if (ctx.interaction.surface !== "transcript") return
  const id = ctx.transcript.cursor?.itemId
  if (!id || ctx.transcript.projectionById[id]?.nodeKind === "message") return
  ctx.controller.transcript({
    type: "fold.set",
    itemId: id,
    folded: folded ?? !ctx.transcript.folded[id],
  })
}

export function toggleAllTools(ctx: VimBindingContext): void {
  const ids = ctx.transcript.order.filter(
    (id) => ctx.transcript.projectionById[id]?.nodeKind === "tool",
  )
  if (!ids.length) return
  const folded =
    ctx.transcript.bulkToolFolded === undefined
      ? !ids.some((id) => ctx.transcript.folded[id])
      : !ctx.transcript.bulkToolFolded
  ctx.controller.transcript({ type: "fold.all", scope: "tools", folded })
}

export function toggleCurrentFold(ctx: VimBindingContext): void {
  setCurrentFold(ctx)
}

export function vimFoldBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    ...(ctx.interaction.surface === "transcript"
      ? [
          { key: "za", cmd: () => setCurrentFold(ctx) },
          { key: "zo", cmd: () => setCurrentFold(ctx, false) },
          { key: "zc", cmd: () => setCurrentFold(ctx, true) },
        ]
      : []),
    {
      key: "zshift+r",
      cmd: () => ctx.controller.transcript({ type: "fold.all", folded: false }),
    },
    {
      key: "zshift+m",
      cmd: () => ctx.controller.transcript({ type: "fold.all", folded: true }),
    },
  ]
}

import type { UiBinding, VimBindingContext } from "./binding-context"

export function commonBindings(ctx: VimBindingContext): UiBinding[] {
  const focus = (surface: "transcript" | "composer") => {
    if (ctx.interaction.mode === "visual") {
      if (ctx.interaction.surface === "composer") ctx.runComposerKey("escape")
      else {
        ctx.controller.transcript({ type: "selection.clear" })
        ctx.controller.dispatchInteraction({ type: "mode.normal" })
      }
    } else if (ctx.interaction.mode === "command") {
      ctx.controller.dispatchInteraction({ type: "mode.normal" })
    }
    ctx.controller.dispatchInteraction({ type: "focus.set", surface })
  }
  return [
    { key: "ctrl+wk", cmd: () => focus("transcript") },
    { key: "ctrl+wj", cmd: () => focus("composer") },
    { key: "ctrl+c", cmd: () => ctx.controller.interrupt() },
  ]
}

import type { UiBinding, VimBindingContext } from "./binding-context"

export const commandBindings = (ctx: VimBindingContext): UiBinding[] => [
  { key: "escape", cmd: () => {
    ctx.controller.dispatchInteraction({ type: "mode.normal" })
    ctx.controller.dispatchInteraction({ type: "focus.set", surface: "transcript" })
  } },
]

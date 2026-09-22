import type { UiBinding, VimBindingContext } from "./binding-context"
export const insertBindings = (ctx: VimBindingContext): UiBinding[] => [
  {
    key: "escape",
    cmd: () => ctx.controller.dispatchInteraction({ type: "mode.normal" }),
  },
  { key: "ctrl+return", cmd: () => ctx.submitComposer("steer") },
]

import type { UiBinding, VimBindingContext } from "./binding-context"

export function commonBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    { key: "ctrl+c", cmd: () => ctx.controller.interrupt() },
  ]
}

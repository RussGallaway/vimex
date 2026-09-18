import type { UiBinding, VimBindingContext } from "./binding-context"

export function transcriptBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    { key: "h", cmd: () => ctx.countedMotion("left") }, { key: "j", cmd: () => ctx.countedMotion("down") },
    { key: "k", cmd: () => ctx.countedMotion("up") }, { key: "l", cmd: () => ctx.countedMotion("right") },
    { key: "0", cmd: () => ctx.countRef.current ? (() => { ctx.countRef.current = `${ctx.countRef.current}0`.slice(0, 4); ctx.controller.dispatchInteraction({ type: "count.push", digit: 0 }) })() : ctx.countedMotion("line-start") },
    { key: "$", cmd: () => ctx.countedMotion("line-end") }, { key: "gg", cmd: () => ctx.countedMotion("first") },
    { key: "shift+g", cmd: () => { ctx.dispatchMotion("last"); ctx.scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER); ctx.controller.transcript({ type: "viewport.tail" }) } },
    { key: "ctrl+e", cmd: () => ctx.scroll("down", "line") }, { key: "ctrl+y", cmd: () => ctx.scroll("up", "line") },
    { key: "ctrl+d", cmd: () => ctx.scroll("down", "half-page") }, { key: "ctrl+u", cmd: () => ctx.scroll("up", "half-page") },
  ]
}

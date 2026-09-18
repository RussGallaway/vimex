import type { UiBinding, VimBindingContext } from "./binding-context"

export function transcriptBindings(ctx: VimBindingContext): UiBinding[] {
  const semantic = (motion: "block-next" | "block-previous" | "message-next" | "message-previous" | "url-next" | "url-previous" | "first-content") => {
    const count = Number(ctx.countRef.current || "1")
    ctx.countRef.current = ""
    ctx.controller.dispatchInteraction({ type: "count.clear" })
    ctx.controller.transcript({ type: "navigate", motion, count })
  }
  const repeatSearch = (reverse = false) => {
    const count = Number(ctx.countRef.current || "1")
    ctx.countRef.current = ""
    ctx.controller.dispatchInteraction({ type: "count.clear" })
    ctx.controller.transcript({ type: "search.next", reverse, count })
  }
  const search = (prefix: "/" | "?") => {
    ctx.controller.dispatchInteraction({ type: "mode.command" })
    ctx.controller.dispatchInteraction({ type: "command.change", value: prefix })
  }
  return [
    { key: "{", cmd: () => semantic("block-previous") }, { key: "}", cmd: () => semantic("block-next") },
    { key: "[[", cmd: () => semantic("message-previous") }, { key: "]]", cmd: () => semantic("message-next") },
    { key: "[u", cmd: () => semantic("url-previous") }, { key: "]u", cmd: () => semantic("url-next") },
    { key: "^", cmd: () => semantic("first-content") },
    { key: "/", cmd: () => search("/") }, { key: "?", cmd: () => search("?") },
    { key: "n", cmd: () => repeatSearch() },
    { key: "shift+n", cmd: () => repeatSearch(true) },
    { key: "r", cmd: () => ctx.controller.transcript({ type: "reference" }) },
    { key: "ctrl+f", cmd: () => { ctx.scroll("down", "page") } },
    { key: "ctrl+b", cmd: () => { ctx.scroll("up", "page") } },
    { key: "h", cmd: () => ctx.countedMotion("left") }, { key: "j", cmd: () => ctx.countedMotion("down") },
    { key: "k", cmd: () => ctx.countedMotion("up") }, { key: "l", cmd: () => ctx.countedMotion("right") },
    { key: "0", cmd: () => ctx.countRef.current ? (() => { ctx.countRef.current = `${ctx.countRef.current}0`.slice(0, 4); ctx.controller.dispatchInteraction({ type: "count.push", digit: 0 }) })() : ctx.countedMotion("line-start") },
    { key: "$", cmd: () => ctx.countedMotion("line-end") }, { key: "gg", cmd: () => ctx.countedMotion("first") },
    { key: "shift+g", cmd: () => { ctx.dispatchMotion("last"); ctx.scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER); ctx.controller.transcript({ type: "viewport.tail" }) } },
    { key: "ctrl+e", cmd: () => ctx.scroll("down", "line") }, { key: "ctrl+y", cmd: () => ctx.scroll("up", "line") },
    { key: "ctrl+d", cmd: () => ctx.scroll("down", "half-page") }, { key: "ctrl+u", cmd: () => ctx.scroll("up", "half-page") },
  ]
}

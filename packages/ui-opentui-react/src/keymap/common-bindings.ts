import { toggleAllTools, toggleCurrentFold } from "./fold-bindings"
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
    if (surface === "transcript" && ctx.interaction.surface === "composer")
      ctx.enterVisibleTranscript()
    ctx.controller.dispatchInteraction({ type: "focus.set", surface })
  }
  const slashEditing =
    ctx.interaction.mode === "insert" &&
    ctx.composer.text.startsWith("/") &&
    !ctx.composer.text.includes("\n")
  return [
    ...(ctx.interaction.mode !== "command" && !slashEditing
      ? ([
          { key: "shift+tab", cmd: () => toggleAllTools(ctx) },
          ...(ctx.interaction.surface === "transcript" &&
          ctx.interaction.mode === "normal"
            ? [{ key: "return", cmd: () => toggleCurrentFold(ctx) }]
            : []),
          {
            key: "ctrl+o",
            cmd: () => ctx.controller.transcript({ type: "jump.back" }),
          },
          {
            key: "ctrl+i",
            cmd: () => ctx.controller.transcript({ type: "jump.forward" }),
          },
          ...(!ctx.distinctControlI
            ? [
                {
                  key: "tab",
                  cmd: () =>
                    ctx.controller.transcript({ type: "jump.forward" }),
                },
              ]
            : []),
        ] satisfies UiBinding[])
      : []),
    ...(ctx.interaction.surface === "composer" &&
    ctx.interaction.mode !== "command"
      ? ([
          { key: "ctrl+e", cmd: () => ctx.scroll("down", "line") },
          { key: "ctrl+y", cmd: () => ctx.scroll("up", "line") },
          { key: "ctrl+d", cmd: () => ctx.scroll("down", "half-page") },
          { key: "ctrl+u", cmd: () => ctx.scroll("up", "half-page") },
        ] satisfies UiBinding[])
      : []),
    { key: "up", cmd: () => focus("transcript") },
    { key: "down", cmd: () => focus("composer") },
    { key: "ctrl+k", cmd: () => focus("transcript") },
    { key: "ctrl+j", cmd: () => focus("composer") },
    { key: "linefeed", cmd: () => focus("composer") },
    { key: "ctrl+wk", cmd: () => focus("transcript") },
    { key: "ctrl+wj", cmd: () => focus("composer") },
    { key: "ctrl+c", cmd: () => ctx.controller.interrupt() },
  ]
}

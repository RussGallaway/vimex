import { vimFoldBindings } from "./fold-bindings"
import type { UiBinding, VimBindingContext } from "./binding-context"
import { countBindings } from "./binding-context"
import { transcriptBindings } from "./transcript-bindings"

export function visualBindings(ctx: VimBindingContext): UiBinding[] {
  const shape = (shape: "character" | "line" | "block") => {
    if (ctx.interaction.surface === "composer") {
      if (shape !== "block")
        ctx.runComposerKey(shape === "line" ? "shift+v" : "v")
      return
    }
    ctx.countRef.current = ""
    ctx.controller.dispatchInteraction({ type: "count.clear" })
    if (ctx.transcript.selection?.shape === shape) {
      ctx.controller.transcript({ type: "selection.clear" })
      ctx.controller.dispatchInteraction({ type: "mode.normal" })
    } else ctx.controller.transcript({ type: "selection.shape", shape })
  }
  return [
    { key: "v", cmd: () => shape("character") },
    { key: "shift+v", cmd: () => shape("line") },
    {
      key: ":",
      cmd: () => ctx.controller.dispatchInteraction({ type: "mode.command" }),
    },
    {
      key: "o",
      cmd: () =>
        ctx.interaction.surface === "composer"
          ? ctx.runComposerKey("o")
          : ctx.controller.transcript({ type: "selection.swap" }),
    },
    {
      key: "ctrl+v",
      cmd: () => shape("block"),
    },
    ...(ctx.interaction.surface === "transcript"
      ? [
          {
            key: "gx",
            cmd: () =>
              ctx.controller.transcript({
                type: "url.open",
                presentationId: ctx.presentationId,
              }),
          },
        ]
      : []),
    {
      key: "escape",
      cmd: () => {
        if (ctx.interaction.surface === "composer") ctx.runComposerKey("escape")
        else {
          ctx.controller.transcript({ type: "selection.clear" })
          ctx.controller.dispatchInteraction({ type: "mode.normal" })
          ctx.controller.dispatchInteraction({
            type: "focus.set",
            surface: "transcript",
          })
        }
      },
    },
    ...(ctx.interaction.surface === "transcript"
      ? [
          ...countBindings(ctx),
          ...transcriptBindings(ctx),
          ...vimFoldBindings(ctx),
        ]
      : [
          ...Array.from({ length: 10 }, (_, digit) => ({
            key: `${digit}`,
            cmd: () => ctx.runComposerKey(`${digit}`),
          })),
          ...[
            "h",
            "j",
            "k",
            "l",
            "w",
            "b",
            "e",
            "shift+w",
            "shift+b",
            "shift+e",
            "^",
            "$",
            "g",
            "shift+g",
            "d",
            "x",
            "c",
          ].map((key) => ({ key, cmd: () => ctx.runComposerKey(key) })),
        ]),
    {
      key: "y",
      cmd: () => {
        if (ctx.interaction.surface === "composer") ctx.runComposerKey("y")
        else
          ctx.controller.transcript({
            type: "copy",
            format: "plain",
            presentationId: ctx.presentationId,
          })
      },
    },
    {
      key: "shift+y",
      cmd: () =>
        ctx.interaction.surface === "transcript" &&
        ctx.controller.transcript({
          type: "copy",
          format: "source",
          presentationId: ctx.presentationId,
        }),
    },
  ]
}

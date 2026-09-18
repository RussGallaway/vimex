import type { UiBinding, VimBindingContext } from "./binding-context"
import { countBindings } from "./binding-context"
import { transcriptBindings } from "./transcript-bindings"

export function normalBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    ...(ctx.interaction.surface === "transcript"
      ? [...countBindings(ctx), ...transcriptBindings(ctx)]
      : Array.from({ length: 10 }, (_, digit) => ({ key: `${digit}`, cmd: () => ctx.runComposerKey(`${digit}`) }))),
    { key: "escape", cmd: () => ctx.controller.dispatchInteraction({ type: "focus.set", surface: "transcript" }) },
    { key: "ctrl+wk", cmd: () => ctx.controller.dispatchInteraction({ type: "focus.set", surface: "transcript" }) },
    { key: "ctrl+wj", cmd: () => ctx.controller.dispatchInteraction({ type: "focus.set", surface: "composer" }) },
    { key: "i", cmd: () => ctx.interaction.surface === "composer" ? ctx.runComposerKey("i") : ctx.controller.dispatchInteraction({ type: "mode.insert" }) },
    { key: "v", cmd: () => {
      if (ctx.interaction.surface === "composer") ctx.runComposerKey("v")
      else ctx.beginVisual("character")
    } },
    { key: "shift+v", cmd: () => ctx.interaction.surface === "transcript" && ctx.beginVisual("line") },
    { key: ":", cmd: () => ctx.controller.dispatchInteraction({ type: "mode.command" }) },
    { key: "s", cmd: () => ctx.openOverlay("sessions") },
    { key: "a", cmd: () => ctx.interaction.surface === "composer" ? ctx.runComposerKey("a") : ctx.openOverlay("approvals") },
    ...(ctx.interaction.surface === "transcript" ? [
      { key: "ga", cmd: () => ctx.openOverlay("agents") },
      { key: "gx", cmd: () => ctx.controller.transcript({ type: "url.open" }) },
    ] satisfies UiBinding[] : []),
    { key: "f", cmd: () => ctx.controller.requestFork(ctx.transcript.cursor?.itemId) },
    { key: "za", cmd: () => ctx.transcript.cursor && ctx.controller.transcript({ type: "fold.set", itemId: ctx.transcript.cursor.itemId, folded: !ctx.transcript.folded[ctx.transcript.cursor.itemId] }) },
    { key: "zo", cmd: () => ctx.transcript.cursor && ctx.controller.transcript({ type: "fold.set", itemId: ctx.transcript.cursor.itemId, folded: false }) },
    { key: "zc", cmd: () => ctx.transcript.cursor && ctx.controller.transcript({ type: "fold.set", itemId: ctx.transcript.cursor.itemId, folded: true }) },
    { key: "zR", cmd: () => ctx.controller.transcript({ type: "fold.all", folded: false }) },
    { key: "zM", cmd: () => ctx.controller.transcript({ type: "fold.all", folded: true }) },
    ...(ctx.interaction.surface === "composer" ? [
      ...["h", "j", "k", "l", "w", "b", "e", "^", "$", "g", "d", "shift+g", "x", "u", "ctrl+r", "shift+r", "shift+d", "shift+c", "p", "shift+p", "o", "shift+o", "shift+i", "shift+a", "return"]
        .map((key) => ({ key, cmd: () => ctx.runComposerKey(key) })),
    ] satisfies UiBinding[] : []),
  ]
}

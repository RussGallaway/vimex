import { vimFoldBindings } from "./fold-bindings"
import type { UiBinding, VimBindingContext } from "./binding-context"
import { countBindings } from "./binding-context"
import { transcriptBindings } from "./transcript-bindings"

export function normalBindings(ctx: VimBindingContext): UiBinding[] {
  return [
    { key: "<leader>a", cmd: () => ctx.openOverlay("approvals") },
    { key: "<leader>s", cmd: () => ctx.openOverlay("sessions") },
    { key: "<leader>q", cmd: () => ctx.openOverlay("questions") },
    { key: "<leader>?", cmd: () => ctx.openOverlay("help") },
    ...(ctx.interaction.surface === "transcript"
      ? [...countBindings(ctx), ...transcriptBindings(ctx)]
      : Array.from({ length: 10 }, (_, digit) => ({ key: `${digit}`, cmd: () => ctx.runComposerKey(`${digit}`) }))),
    { key: "escape", cmd: () => ctx.controller.dispatchInteraction({ type: "focus.set", surface: "transcript" }) },
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
    ...vimFoldBindings(ctx),
    ...(ctx.interaction.surface === "composer" ? [
      ...["h", "j", "k", "l", "w", "b", "e", "^", "$", "g", "d", "shift+g", "x", "u", "ctrl+r", "shift+r", "shift+d", "shift+c", "p", "shift+p", "o", "shift+o", "shift+i", "shift+a", "return"]
        .map((key) => ({ key, cmd: () => ctx.runComposerKey(key) })),
    ] satisfies UiBinding[] : []),
  ]
}

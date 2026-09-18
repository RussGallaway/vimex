import type { CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerLeader } from "@opentui/keymap/addons"

export function createVimexKeymap(renderer: CliRenderer) {
  const keymap = createDefaultOpenTuiKeymap(renderer)
  // Legacy terminals encode Ctrl-H as BS; ordinary Backspace usually uses DEL.
  // Keep the original event intact so native editing still works without a pane binding.
  keymap.prependEventMatchResolver((event, context) => event.raw === "\b"
    ? [context.resolveKey("ctrl+h"), context.resolveKey("backspace")]
    : undefined)
  registerLeader(keymap, { trigger: "space" })
  return keymap
}

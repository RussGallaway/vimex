import type { CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerLeader } from "@opentui/keymap/addons"

export function createVimexKeymap(renderer: CliRenderer) {
  const keymap = createDefaultOpenTuiKeymap(renderer)
  registerLeader(keymap, { trigger: "space" })
  return keymap
}

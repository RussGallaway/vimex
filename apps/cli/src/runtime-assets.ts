import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"

declare const VIMEX_COMPILED: boolean

/** Must run before importing OpenTUI: native libraries resolve at module initialization. */
export function configurePackagedAssets(): void {
  if (typeof VIMEX_COMPILED !== "undefined" && VIMEX_COMPILED) {
    process.env.OTUI_ASSET_ROOT = join(
      dirname(realpathSync(process.execPath)),
      "assets",
      "opentui",
    )
  }
}

import type { CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { useRenderer } from "@opentui/react"
import { useMemo } from "react"
import { VimexApp } from "./app/App"
import type { VimexAppProps } from "./contracts"

export function VimexRoot(props: VimexAppProps) {
  const renderer = useRenderer()
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer])
  return <KeymapProvider keymap={keymap}><VimexApp {...props} /></KeymapProvider>
}

export function mountVimex(renderer: CliRenderer, props: VimexAppProps) {
  const root = createRoot(renderer)
  const keymap = createDefaultOpenTuiKeymap(renderer)
  root.render(<KeymapProvider keymap={keymap}><VimexApp {...props} /></KeymapProvider>)
  return root
}

export { VimexApp } from "./app/App"
export { FatalBoundary } from "./app/FatalBoundary"
export * from "./contracts"
export * from "./theme"
export * from "./transcript/layout"
export * from "./transcript/rendered-layout"

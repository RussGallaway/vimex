import type { CliRenderer } from "@opentui/core"
import { createVimexKeymap } from "./keymap/create-keymap"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { useRenderer } from "@opentui/react"
import { useMemo } from "react"
import {
  ConnectedSideChatLayout,
  SideChatLayout,
} from "./side-chat/SideChatLayout"
import type {
  VimexAppProps,
  VimexUiController,
  VimexUiSettings,
} from "./contracts"
import type { WorkbenchPublicationHost } from "@vimex/workbench"

export function VimexRoot(props: VimexAppProps) {
  const renderer = useRenderer()
  const keymap = useMemo(() => createVimexKeymap(renderer), [renderer])
  return (
    <KeymapProvider keymap={keymap}>
      <SideChatLayout {...props} />
    </KeymapProvider>
  )
}

/** Production bridge: layout and panes subscribe to Workbench-owned read models. */
export function ConnectedVimexRoot(props: {
  controller: VimexUiController & WorkbenchPublicationHost
  settings?: Partial<VimexUiSettings>
}) {
  const renderer = useRenderer()
  const keymap = useMemo(() => createVimexKeymap(renderer), [renderer])
  return (
    <KeymapProvider keymap={keymap}>
      <ConnectedSideChatLayout {...props} />
    </KeymapProvider>
  )
}

export function mountVimex(renderer: CliRenderer, props: VimexAppProps) {
  const root = createRoot(renderer)
  const keymap = createVimexKeymap(renderer)
  root.render(
    <KeymapProvider keymap={keymap}>
      <SideChatLayout {...props} />
    </KeymapProvider>,
  )
  return root
}

export { VimexApp } from "./app/App"
export { FatalBoundary } from "./app/FatalBoundary"
export * from "./contracts"
export * from "./theme"
export * from "./transcript/layout"
export * from "./transcript/rendered-layout"

export { registerSyntaxParsers } from "./syntax/register-parsers"

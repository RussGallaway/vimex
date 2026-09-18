import { useBindings } from "@opentui/keymap/react"
import { flushSync, useTerminalDimensions } from "@opentui/react"
import type { ThreadId } from "@vimex/conversation"
import { currentSideChat, liveActivity } from "@vimex/workbench"
import { VimexApp } from "../app/App"
import type { VimexAppProps } from "../contracts"
import { emberTide, selectTheme } from "../theme"
import { PaneGeometryContext, type PaneGeometry } from "./pane-geometry"

/** Both apps stay mounted: focus never discards a pane's editing/navigation state. */
export function SideChatLayout(props: VimexAppProps) {
  const { state, controller } = props
  const dimensions = useTerminalDimensions()
  const candidate = currentSideChat(state)
  const side = candidate && state.workspaces[candidate.parentId] && (candidate.status === "creating" || (candidate.threadId && state.workspaces[candidate.threadId])) ? candidate : undefined
  const active = state.activeThreadId
  const overlay = active ? state.workspaces[active]?.interaction.overlay : undefined
  selectTheme(state.preferences?.theme ?? props.settings?.theme ?? "ember-tide", props.settings?.reducedColor ?? false)
  useBindings(() => ({ priority: 190, bindings: side?.visible && !overlay ? [
    { key: "ctrl+wh", cmd: () => controller.sideChat("parent") },
    { key: "ctrl+wl", cmd: () => controller.sideChat("side") },
    { key: "ctrl+ww", cmd: () => controller.sideChat("cycle") },
    { key: "ctrl+w|", cmd: () => controller.sideChat("maximize") },
    { key: "ctrl+w=", cmd: () => controller.sideChat("reset") },
    { key: "ctrl+wc", cmd: () => controller.sideChat("close") },
    { key: "ctrl+wq", cmd: () => controller.sideChat("quit") },
  ].map(binding => ({ ...binding, cmd: () => flushSync(binding.cmd) })) : [] }), [controller, side, active, overlay])
  const stacked = dimensions.width < 110
  const limitedHeight = dimensions.height < (stacked ? 28 : 14)
  const maximized = side?.maximized || limitedHeight || !side?.visible
  const headerHeight = side?.visible ? 1 : 0
  const height = Math.max(1, dimensions.height - headerHeight)
  const mainWidth = Math.floor((dimensions.width - 1) * 0.6)
  const mainHeight = Math.max(4, Math.floor((height - 1) * (active === side?.parentId ? 0.65 : 0.35)))
  const mainGeometry: PaneGeometry = maximized ? { width: dimensions.width, height, x: 0, y: headerHeight }
    : stacked ? { width: dimensions.width, height: mainHeight, x: 0, y: headerHeight }
    : { width: mainWidth, height, x: 0, y: headerHeight }
  const sideGeometry: PaneGeometry = maximized ? mainGeometry
    : stacked ? { width: dimensions.width, height: Math.max(1, height - mainHeight - 1), x: 0, y: mainHeight + headerHeight + 1 }
    : { width: dimensions.width - mainWidth - 1, height, x: mainWidth + 1, y: headerHeight }
  const pane = (id: ThreadId | undefined, label: "MAIN" | "SIDE", geometry: PaneGeometry) => {
    const focused = active === id
    return <box key={id ?? "empty"} onMouseDown={() => { if (!focused && !overlay) flushSync(() => controller.sideChat(label === "MAIN" ? "parent" : "side")) }} id={label === "MAIN" ? "main-pane" : "side-pane"} visible={!maximized || focused} width={geometry.width} height={geometry.height} flexShrink={0} overflow="hidden">
      <PaneGeometryContext.Provider value={geometry}>
        <VimexApp {...props} state={focused ? state : { ...state, activeThreadId: id }} interactive={focused} paneLabel={side?.visible ? label : undefined} />
      </PaneGeometryContext.Provider>
    </box>
  }
  const parentActivity = liveActivity(state, side?.parentId)
  return <box id={side?.visible ? "side-chat-layout" : "side-chat-closed"} width="100%" height="100%" flexDirection="column" backgroundColor={emberTide.background}>
    {side?.visible ? <box height={1} flexShrink={0} backgroundColor={emberTide.backgroundPanel} paddingX={1} flexDirection="row" gap={2}>
      <text flexShrink={0} fg={emberTide.blueBright}><b>{active === side.threadId ? "SIDE" : "MAIN"}{maximized ? " · maximized" : " · focused"}</b></text>
      <text flexGrow={1} minWidth={0} truncate wrapMode="none" fg={emberTide.textMuted}>{side.status === "creating" ? "Opening side chat…" : side.status === "quitting" ? "Quitting side…" : limitedHeight ? `Main: ${parentActivity.label ?? "idle"} · ${side.contextLabel ?? "Side conversation"}` : side.contextLabel ?? "Forked side conversation"}</text>
      {dimensions.width >= 90 ? <text flexShrink={0} fg={emberTide.textMuted}>^W w focus · ^W | maximize · ^W c close · ^W q quit</text> : null}
    </box> : null}
    <box flexDirection={stacked ? "column" : "row"} flexGrow={1} minHeight={0}>
      {pane(side?.parentId ?? active, "MAIN", mainGeometry)}
      {!maximized ? <box width={stacked ? "100%" : 1} height={stacked ? 1 : "100%"} flexShrink={0} backgroundColor={emberTide.borderMuted} /> : null}
      {side?.threadId && state.workspaces[side.threadId] ? pane(side.threadId, "SIDE", sideGeometry) : side?.visible && !maximized ? <box key="side-opening" id="side-opening" width={sideGeometry.width} height={sideGeometry.height} flexShrink={0} flexDirection="column" paddingX={2} paddingY={1} backgroundColor={emberTide.backgroundPanel}>
        <text fg={emberTide.blueBright}><b>SIDE</b></text>
        <text marginTop={1} fg={emberTide.textSoft}>Opening side chat…</text>
        <text marginTop={1} fg={emberTide.textMuted}>Forking parent context. You can keep working in the main pane.</text>
      </box> : null}
    </box>
  </box>
}

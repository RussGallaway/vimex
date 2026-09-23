import { useBindings } from "@opentui/keymap/react"
import { flushSync, useTerminalDimensions } from "@opentui/react"
import type { ThreadId } from "@vimex/conversation"
import {
  captureWorkbenchLayout,
  type TranscriptPresentationId,
  type WorkbenchLayoutSnapshot,
  type WorkbenchPublicationHost,
  type WorkbenchState,
} from "@vimex/workbench"
import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { VimexApp } from "../app/App"
import type {
  VimexAppProps,
  VimexUiController,
  VimexUiSettings,
} from "../contracts"
import { emberTide, selectTheme } from "../theme"
import { PaneGeometryContext, type PaneGeometry } from "./pane-geometry"

/** Both apps stay mounted: focus never discards a pane's editing/navigation state. */
export function SideChatLayout(props: VimexAppProps) {
  const layout = captureWorkbenchLayout(props.state)
  return (
    <SideChatFrame
      layout={layout}
      controller={props.controller}
      settings={props.settings}
      renderPane={({
        id,
        label,
        presentationId,
        interactive,
        presentationVisible,
      }) => (
        <VimexApp
          {...props}
          state={
            interactive ? props.state : { ...props.state, activeThreadId: id }
          }
          interactive={interactive}
          presentationVisible={presentationVisible}
          paneLabel={layout.side?.visible ? label : undefined}
          presentationId={presentationId}
        />
      )}
    />
  )
}

export function ConnectedSideChatLayout(props: {
  controller: VimexUiController & WorkbenchPublicationHost
  settings?: Partial<VimexUiSettings>
}) {
  const layout = useSyncExternalStore(
    props.controller.subscribeLayout,
    props.controller.getLayoutSnapshot,
    props.controller.getLayoutSnapshot,
  )
  return (
    <SideChatFrame
      layout={layout}
      controller={props.controller}
      settings={props.settings}
      renderPane={({
        label,
        presentationId,
        interactive,
        presentationVisible,
      }) => (
        <ConnectedPane
          controller={props.controller}
          settings={props.settings}
          presentationId={presentationId}
          interactive={interactive}
          presentationVisible={presentationVisible}
          paneLabel={layout.side?.visible ? label : undefined}
        />
      )}
    />
  )
}

function ConnectedPane(props: {
  controller: VimexUiController & WorkbenchPublicationHost
  settings?: Partial<VimexUiSettings>
  presentationId: TranscriptPresentationId
  interactive: boolean
  presentationVisible: boolean
  paneLabel?: "MAIN" | "SIDE"
}) {
  const state = useVisiblePresentationSnapshot(
    props.controller,
    props.presentationId,
    props.presentationVisible,
  )
  return (
    <VimexApp
      state={state}
      controller={props.controller}
      settings={props.settings}
      interactive={props.interactive}
      presentationVisible={props.presentationVisible}
      paneLabel={props.paneLabel}
      presentationId={props.presentationId}
    />
  )
}

/** Retains the last visible pane model without reconciling hidden publications. */
export function useVisiblePresentationSnapshot(
  controller: WorkbenchPublicationHost,
  presentationId: TranscriptPresentationId,
  visible: boolean,
): WorkbenchState {
  const subscribe = useCallback(
    (listener: () => void) =>
      visible
        ? controller.subscribePresentation(presentationId, listener)
        : () => {},
    [controller, presentationId, visible],
  )
  const retained = useRef<
    | { presentationId: TranscriptPresentationId; state: WorkbenchState }
    | undefined
  >(undefined)
  if (
    !retained.current ||
    retained.current.presentationId !== presentationId ||
    visible
  ) {
    retained.current = {
      presentationId,
      state: controller.getPresentationSnapshot(presentationId),
    }
  }
  const getSnapshot = useCallback(() => {
    if (!visible) return retained.current!.state
    const state = controller.getPresentationSnapshot(presentationId)
    retained.current = { presentationId, state }
    return state
  }, [controller, presentationId, visible])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

interface PaneRenderProps {
  id?: ThreadId
  label: "MAIN" | "SIDE"
  presentationId: TranscriptPresentationId
  interactive: boolean
  presentationVisible: boolean
}

function SideChatFrame(props: {
  layout: WorkbenchLayoutSnapshot
  controller: VimexUiController
  settings?: Partial<VimexUiSettings>
  renderPane(props: PaneRenderProps): ReactNode
}) {
  const { layout, controller } = props
  const dimensions = useTerminalDimensions()
  const side = layout.side
  const active = layout.activeThreadId
  const overlay = layout.overlay
  selectTheme(
    layout.theme ?? props.settings?.theme ?? "ember-tide",
    props.settings?.reducedColor ?? false,
  )
  useBindings(
    () => ({
      priority: 190,
      bindings:
        side?.visible && !overlay
          ? [
              { key: "ctrl+h", cmd: () => controller.sideChat("parent") },
              { key: "ctrl+l", cmd: () => controller.sideChat("side") },
              { key: "ctrl+wh", cmd: () => controller.sideChat("parent") },
              { key: "ctrl+wl", cmd: () => controller.sideChat("side") },
              { key: "ctrl+ww", cmd: () => controller.sideChat("cycle") },
              { key: "ctrl+w|", cmd: () => controller.sideChat("maximize") },
              { key: "ctrl+w=", cmd: () => controller.sideChat("reset") },
              { key: "ctrl+wc", cmd: () => controller.sideChat("close") },
              { key: "ctrl+wq", cmd: () => controller.sideChat("quit") },
            ].map((binding) => ({
              ...binding,
              cmd: () => flushSync(binding.cmd),
            }))
          : [],
    }),
    [controller, side, active, overlay],
  )
  const stacked = dimensions.width < 110
  const limitedHeight = dimensions.height < (stacked ? 28 : 14)
  const maximized = side?.maximized || limitedHeight || !side?.visible
  const height = Math.max(1, dimensions.height)
  const mainWidth = Math.floor((dimensions.width - 1) * 0.6)
  const mainHeight = Math.max(
    4,
    Math.floor((height - 1) * (active === side?.parentId ? 0.65 : 0.35)),
  )
  const mainGeometry: PaneGeometry = maximized
    ? { width: dimensions.width, height, x: 0, y: 0 }
    : stacked
      ? { width: dimensions.width, height: mainHeight, x: 0, y: 0 }
      : { width: mainWidth, height, x: 0, y: 0 }
  const sideGeometry: PaneGeometry = maximized
    ? mainGeometry
    : stacked
      ? {
          width: dimensions.width,
          height: Math.max(1, height - mainHeight - 1),
          x: 0,
          y: mainHeight + 1,
        }
      : {
          width: dimensions.width - mainWidth - 1,
          height,
          x: mainWidth + 1,
          y: 0,
        }
  const pane = (
    id: ThreadId | undefined,
    label: "MAIN" | "SIDE",
    geometry: PaneGeometry,
  ) => {
    const focused = active === id
    const presentationVisible =
      (label === "MAIN" || Boolean(side?.visible)) && (!maximized || focused)
    const presentationId = label === "MAIN" ? "main" : "side"
    return (
      <box
        key={id ?? "empty"}
        onMouseDown={() => {
          if (!focused && !overlay)
            flushSync(() =>
              controller.sideChat(label === "MAIN" ? "parent" : "side"),
            )
        }}
        id={label === "MAIN" ? "main-pane" : "side-pane"}
        visible={presentationVisible}
        width={geometry.width}
        height={geometry.height}
        flexShrink={0}
        overflow="hidden"
      >
        <PaneGeometryContext.Provider value={geometry}>
          {props.renderPane({
            id,
            label,
            presentationId,
            interactive: focused,
            presentationVisible,
          })}
        </PaneGeometryContext.Provider>
      </box>
    )
  }
  return (
    <box
      id={side?.visible ? "side-chat-layout" : "side-chat-closed"}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={emberTide.background}
    >
      <box
        flexDirection={stacked ? "column" : "row"}
        flexGrow={1}
        minHeight={0}
      >
        {pane(side?.parentId ?? active, "MAIN", mainGeometry)}
        {!maximized ? (
          <box
            width={stacked ? "100%" : 1}
            height={stacked ? 1 : "100%"}
            flexShrink={0}
            backgroundColor={emberTide.borderMuted}
          />
        ) : null}
        {side?.threadId && layout.sideThreadReady ? (
          pane(side.threadId, "SIDE", sideGeometry)
        ) : side?.visible && !maximized ? (
          <box
            key="side-opening"
            id="side-opening"
            width={sideGeometry.width}
            height={sideGeometry.height}
            flexShrink={0}
            flexDirection="column"
            paddingX={2}
            paddingY={1}
            backgroundColor={emberTide.backgroundPanel}
          >
            <text fg={emberTide.blueBright}>
              <b>SIDE</b>
            </text>
            <text marginTop={1} fg={emberTide.textSoft}>
              Opening side chat…
            </text>
            <text marginTop={1} fg={emberTide.textMuted}>
              Forking parent context. You can keep working in the main pane.
            </text>
          </box>
        ) : null}
      </box>
    </box>
  )
}

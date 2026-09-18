import { useRef } from "react"
import { useBindings } from "@opentui/keymap/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { OverlayFrame } from "../app/OverlayFrame"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { emberTide } from "../theme"
import { manualSections } from "./manual.generated"

export function ManualOverlay() {
  const dimensions = usePaneGeometry()
  const scroll = useRef<ScrollBoxRenderable>(null)
  useBindings(() => ({ priority: 250, bindings: [
    ...["j", "down", "ctrl+e"].map(key => ({ key, cmd: () => scroll.current?.scrollBy(1, "step") })),
    ...["k", "up", "ctrl+y"].map(key => ({ key, cmd: () => scroll.current?.scrollBy(-1, "step") })),
    { key: "ctrl+d", cmd: () => scroll.current?.scrollBy(0.5, "viewport") },
    { key: "ctrl+u", cmd: () => scroll.current?.scrollBy(-0.5, "viewport") },
    { key: "ctrl+f", cmd: () => scroll.current?.scrollBy(1, "viewport") },
    { key: "ctrl+b", cmd: () => scroll.current?.scrollBy(-1, "viewport") },
    { key: "gg", cmd: () => scroll.current?.scrollTo(0) },
    { key: "shift+g", cmd: () => scroll.current?.scrollTo(scroll.current.scrollHeight) },
  ] }), [])
  return <OverlayFrame title="vimex(1) — User manual" width={96}>
    <scrollbox id="manual-scroll" ref={scroll} height={Math.max(1, Math.floor(dimensions.height * 0.85) - 5)}>
      {manualSections.map(section => <box key={section.title} flexDirection="column" marginBottom={1}>
        <text fg={emberTide.amber}><b>{section.title}</b></text>
        <text fg={emberTide.textSoft}>{section.body}</text>
      </box>)}
    </scrollbox>
    <text height={1} fg={emberTide.textMuted} wrapMode="none" truncate>j/k scroll · ctrl-d/u page · gg/G start/end · esc close</text>
  </OverlayFrame>
}

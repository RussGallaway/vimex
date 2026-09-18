import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { flushSync, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, type RefObject } from "react"
import type { TranscriptState } from "@vimex/transcript"
import type { VimexUiController } from "../contracts"
import type { TranscriptLayout } from "./layout"
import { flashTargets, type FlashTarget } from "./flash-targets"
import { measureRenderedTranscript, measuredPoint, bottomVisiblePoint } from "./rendered-layout"
import { emberTide } from "../theme"

/** Transient prompt: labels decorate native cells without changing transcript source. */
export function FlashJump(props: {
  transcript: TranscriptState; layout: TranscriptLayout; scrollRef: RefObject<ScrollBoxRenderable | null>
  controller: VimexUiController; extend: boolean; fromComposer: boolean; onClose(): void
}) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const input = useRef<InputRenderable>(null)
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const viewport = props.scrollRef.current?.viewport
  const results = viewport ? flashTargets(props.transcript, props.layout, viewport, query, page) : { matches: [], labels: [], pages: 1 }
  useEffect(() => { input.current?.focus() }, [])
  const jump = (target?: FlashTarget) => {
    const scroll = props.scrollRef.current
    if (!target || !scroll) return
    // Resolve again at key time; a stream/reflow must never jump to an old screen cell.
    const current = measureRenderedTranscript(renderer, scroll, props.transcript)
    const point = current && measuredPoint(current, target)
    if (!point || point.screenY < scroll.viewport.screenY || point.screenY >= scroll.viewport.screenY + scroll.viewport.height) return
    const origin = props.fromComposer && current ? bottomVisiblePoint(current, scroll) : undefined
    flushSync(() => {
      props.controller.transcript({ type: "jump", target: { itemId: point.itemId, graphemeOffset: point.graphemeOffset }, preferredScreenRow: point.screenY - scroll.viewport.screenY, extend: props.extend, origin, originPreferredScreenRow: origin ? origin.screenY - scroll.viewport.screenY : undefined })
      props.controller.dispatchInteraction({ type: "focus.set", surface: "transcript" })
      if (!props.extend) props.controller.dispatchInteraction({ type: "mode.normal" })
      props.onClose()
    })
  }
  useBindings(() => ({ priority: 300, bindings: [
    { key: "escape", cmd: () => flushSync(props.onClose) },
    { key: "ctrl+c", cmd: () => flushSync(props.onClose) },
    { key: "ctrl+g", cmd: () => flushSync(props.onClose) },
    { key: "return", cmd: () => jump(results.labels[0] ?? results.matches[0]) },
    { key: "tab", cmd: () => flushSync(() => setPage(value => (value + 1) % results.pages)) },
  ] }), [results, props.onClose, props.transcript])
  return <>
    {results.labels.map(target => <text key={`${target.itemId}:${target.graphemeOffset}`} id={`flash-label:${target.label}`}
      position="absolute" left={target.screenX} top={target.screenY} height={1} width={1} zIndex={50}
      fg={emberTide.background} bg={emberTide.amber}><b>{target.label}</b></text>)}
    <box id="flash-prompt" position="absolute" bottom={0} left={0} right={0} height={1} zIndex={51} flexDirection="row" paddingX={2} backgroundColor={emberTide.backgroundRaised}>
      <text fg={emberTide.amber}>Jump / </text>
      <input id="flash-query" ref={input} flexGrow={1} minWidth={0} value={query} textColor={emberTide.text} backgroundColor={emberTide.backgroundRaised}
        placeholder="type text, then its label" onInput={value => {
          const label = value.startsWith(query) && value.length === query.length + 1 ? results.labels.find(target => target.label === value.slice(-1)) : undefined
          if (label) jump(label)
          else flushSync(() => { setQuery(value); setPage(0) })
        }} />
      <text flexShrink={0} fg={emberTide.textMuted}>{dimensions.width < 70 ? "↵ jump · Esc" : `${query ? results.matches.length + " matches · " : ""}Enter jump · Tab labels · Esc cancel`}</text>
    </box>
  </>
}

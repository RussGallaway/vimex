import type { ScrollBoxRenderable } from "@opentui/core"
import type { AvailableModel } from "@vimex/workbench"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function ModelsOverlay(props: {
  models?: readonly AvailableModel[]
  error?: string
  selected: number
  picker: { stage: "models" } | { stage: "efforts"; modelId: string }
}) {
  const list = useRef<ScrollBoxRenderable>(null)
  const modelId = props.picker.stage === "efforts" ? props.picker.modelId : undefined
  const model = modelId ? props.models?.find(candidate => candidate.id === modelId) : undefined
  const selected = props.picker.stage === "models" ? props.models?.[props.selected]?.id : model?.efforts[props.selected]
  useEffect(() => {
    if (selected) list.current?.scrollChildIntoView(`${props.picker.stage === "models" ? "model" : "effort"}-row:${selected}`)
  }, [selected])
  return <OverlayFrame title={props.picker.stage === "models" ? "Models" : `Thinking · ${model?.label ?? modelId}`} width={88}>
    <text height={1} fg={emberTide.textMuted}>{props.picker.stage === "models" ? "j/k choose · enter thinking level · esc close" : "j/k choose · enter apply · esc back"}</text>
    <scrollbox ref={list} minHeight={4} flexGrow={1} marginTop={1}>
      {props.picker.stage === "models" ? props.models?.map((model, index) => <box id={`model-row:${model.id}`} key={model.id} height={3} flexShrink={0} paddingX={1}
        backgroundColor={index === props.selected ? emberTide.selection : emberTide.backgroundRaised}>
        <text height={1} wrapMode="none" truncate fg={index === props.selected ? emberTide.selectionText : emberTide.text}>{model.label} · {model.id}</text>
        <text height={1} wrapMode="none" truncate fg={emberTide.textMuted}>Thinking: {model.efforts.join(" · ") || "default"}</text>
      </box>) : model?.efforts.map((effort, index) => <box id={`effort-row:${effort}`} key={effort} height={2} flexShrink={0} paddingX={1}
        backgroundColor={index === props.selected ? emberTide.selection : emberTide.backgroundRaised}>
        <text height={1} fg={index === props.selected ? emberTide.selectionText : emberTide.text}>{effort}</text>
      </box>)}
      {props.picker.stage === "models" ? (props.error ? <box><text fg={emberTide.red} wrapMode="word">Could not load models: {props.error}</text><text fg={emberTide.textMuted} wrapMode="word">Esc, then :model to retry.</text></box> : !props.models ? <text fg={emberTide.textMuted}>Loading models…</text> : props.models.length === 0 ? <text fg={emberTide.textMuted}>No models available</text> : null) : !model ? <text fg={emberTide.red}>Selected model is no longer available.</text> : null}
    </scrollbox>
  </OverlayFrame>
}

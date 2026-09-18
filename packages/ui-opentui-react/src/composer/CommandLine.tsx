import type { InputRenderable } from "@opentui/core"
import type { RefObject } from "react"
import type { VimexUiController } from "../contracts"
import { emberTide } from "../theme"

export function commandPrompt(value: string): ":" | "/" | "?" {
  return value.startsWith("/") ? "/" : value.startsWith("?") ? "?" : ":"
}
export function commandBody(value: string): string {
  const prompt = commandPrompt(value)
  return prompt === ":" ? value.replace(/^:/, "") : value.slice(1)
}

export function CommandLine(props: { value: string; inputRef: RefObject<InputRenderable | null>; controller: VimexUiController; onSubmit(value: string): void }) {
  const prompt = commandPrompt(props.value)
  return <box height={1} flexShrink={0} flexDirection="row" paddingX={2} backgroundColor={emberTide.backgroundRaised}>
    <text fg={emberTide.ember}>{prompt}</text>
    <input id="command-line" ref={props.inputRef} flexGrow={1} value={commandBody(props.value)} textColor={emberTide.text}
      cursorColor={emberTide.ember} backgroundColor={emberTide.backgroundRaised}
      onInput={(value) => props.controller.dispatchInteraction({ type: "command.change", value: prompt === ":" ? value : `${prompt}${value}` })}
      onSubmit={() => {
        const body = props.inputRef.current?.value ?? commandBody(props.value)
        props.onSubmit(prompt === ":" ? body : `${prompt}${body}`)
        props.controller.dispatchInteraction({ type: "mode.normal" })
      }} />
  </box>
}

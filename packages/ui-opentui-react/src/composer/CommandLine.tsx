import type { InputRenderable } from "@opentui/core"
import type { RefObject } from "react"
import type { VimexUiController } from "../contracts"
import { emberTide } from "../theme"

export function CommandLine(props: { value: string; inputRef: RefObject<InputRenderable | null>; controller: VimexUiController }) {
  return <box height={1} flexShrink={0} flexDirection="row" paddingX={2} backgroundColor={emberTide.backgroundRaised}>
    <text fg={emberTide.ember}>:</text>
    <input id="command-line" ref={props.inputRef} flexGrow={1} value={props.value} textColor={emberTide.text}
      cursorColor={emberTide.ember} backgroundColor={emberTide.backgroundRaised}
      onInput={(value) => props.controller.dispatchInteraction({ type: "command.change", value })}
      onSubmit={() => {
        props.controller.executeCommand(props.inputRef.current?.value ?? props.value)
        props.controller.dispatchInteraction({ type: "mode.normal" })
      }} />
  </box>
}

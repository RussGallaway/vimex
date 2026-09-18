import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import { commandCompletions, parseCommand, validateCommand } from "@vimex/interaction"
import type { InputRenderable } from "@opentui/core"
import type { AvailableModel } from "@vimex/workbench"
import { useEffect, useState, type RefObject } from "react"
import { CommandCompletionDrawer } from "./CommandCompletionDrawer"
import type { VimexUiController } from "../contracts"
import { emberTide } from "../theme"

export function commandPrompt(value: string): ":" | "/" | "?" {
  return value.startsWith("/") ? "/" : value.startsWith("?") ? "?" : ":"
}
export function commandBody(value: string): string {
  const prompt = commandPrompt(value)
  return prompt === ":" ? value.replace(/^:/, "") : value.slice(1)
}

export function CommandLine(props: { value: string; models?: readonly AvailableModel[]; currentModel?: string; sessionIds?: readonly string[]; inputRef: RefObject<InputRenderable | null>; controller: VimexUiController; onSubmit(value: string): void }) {
  useEffect(() => { const input = props.inputRef.current; if (input) input.cursorOffset = input.value.length }, [props.inputRef])
  const prompt = commandPrompt(props.value)
  const completionOptions = {
    models: props.models?.map(model => model.id),
    modelEfforts: Object.fromEntries(props.models?.map(model => [model.id, model.efforts]) ?? []),
    currentModel: props.currentModel,
    sessionIds: props.sessionIds,
  }
  const choices = prompt === ":" ? commandCompletions(props.value, completionOptions).map(value => value.slice(1)) : []
  const [selection, setSelection] = useState({ query: "", index: 0, chosen: false })
  const [validation, setValidation] = useState({ query: "", message: "" })
  const selected = selection.query === props.value ? Math.min(selection.index, Math.max(0, choices.length - 1)) : 0
  const move = (delta: number) => flushSync(() => setSelection(current => ({ query: props.value, chosen: true,
    index: Math.max(0, Math.min(choices.length - 1, (current.query === props.value ? current.index : 0) + delta)),
  })))
  const complete = () => {
    const live = props.inputRef.current?.value ?? commandBody(props.value)
    const current = commandCompletions(live, completionOptions).map(value => value.slice(1))
    const choice = current[live === commandBody(props.value) ? selected : 0]
    if (choice) flushSync(() => {
      const completed = `${choice} `
      const input = props.inputRef.current
      input?.setText(completed)
      if (input) input.cursorOffset = completed.length
      props.controller.dispatchInteraction({ type: "command.change", value: completed })
    })
  }
  useBindings(() => ({ priority: 190, bindings: prompt === ":" ? [
    { key: "down", cmd: () => move(1) }, { key: "up", cmd: () => move(-1) }, { key: "tab", cmd: complete },
  ] : [] }), [prompt, selected, choices, props.value, props.models, props.currentModel, props.sessionIds, props.controller])
  const submit = () => {
    const body = props.inputRef.current?.value ?? commandBody(props.value)
    const matches = commandCompletions(body, completionOptions).map(value => value.slice(1))
    const chosen = body === commandBody(props.value) && selection.query === props.value && selection.chosen
    const selectedChoice = matches[body === commandBody(props.value) ? selected : 0]
    const value = prompt !== ":" ? `${prompt}${body}` : chosen && selectedChoice ? selectedChoice : parseCommand(body).kind === "command" || !body.trim() ? body : selectedChoice ?? body
    const parsed = prompt === ":" ? parseCommand(value) : undefined
    const invalid = parsed?.kind === "command" ? validateCommand(parsed, completionOptions) : undefined
    if (invalid) {
      flushSync(() => setValidation({ query: props.value, message: invalid }))
      return
    }
    props.controller.dispatchInteraction({ type: "mode.normal" })
    props.onSubmit(value)
  }
  return <box id="command-bar" height={1} marginTop={1} flexShrink={0} flexDirection="row" paddingX={2} backgroundColor={emberTide.backgroundRaised}>
    {prompt === ":" ? <CommandCompletionDrawer choices={choices} selected={selected} prefix=":" id="command-completion-drawer"
      hint={validation.query === props.value ? validation.message : "↑/↓ choose · tab complete · ctrl-p/n history"} /> : null}
    <text flexShrink={0} fg={emberTide.ember}>{prompt}</text>
    <input id="command-line" ref={props.inputRef} flexGrow={1} flexShrink={1} minWidth={0} value={commandBody(props.value)} textColor={emberTide.text}
      cursorColor={emberTide.ember} backgroundColor={emberTide.backgroundRaised}
      onInput={(value) => flushSync(() => props.controller.dispatchInteraction({ type: "command.change", value: prompt === ":" ? value : `${prompt}${value}` }))}
      onSubmit={submit} />
    <text flexShrink={0} marginLeft={1} fg={emberTide.ember}>COMMAND</text>
  </box>
}

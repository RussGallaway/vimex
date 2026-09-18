import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import type { SubmissionIntent } from "@vimex/composer"
import { useRef, useState, type RefObject } from "react"
import { codeUnitOffsetToGraphemeOffset, type InteractionState } from "@vimex/interaction"
import type { VimexUiController } from "../contracts"
import { slashCommandChoices } from "./slash-commands"

export function useSlashCommands(options: {
  text: string
  textareaRef: RefObject<TextareaRenderable | null>
  interaction: InteractionState
  controller: VimexUiController
  onExecute(command: string): void
}) {
  const { interaction, controller } = options
  const active = interaction.mode === "insert" && interaction.surface === "composer" && !interaction.overlay
    && options.text.startsWith("/") && !options.text.includes("\n")
  const choices = slashCommandChoices(options.text)
  const [selection, setSelection] = useState({ query: "", index: 0 })
  const selected = selection.query === options.text ? Math.min(selection.index, Math.max(0, choices.length - 1)) : 0
  const liveSelection = useRef(selected)
  liveSelection.current = selected
  const changeDraft = (text: string, cursor: number) => flushSync(() => controller.changeDraft(text, cursor))
  const move = (delta: number) => flushSync(() => {
    const index = Math.max(0, Math.min(choices.length - 1, liveSelection.current + delta))
    liveSelection.current = index
    setSelection({ query: options.text, index })
  })
  const liveChoice = () => {
    const text = options.textareaRef.current?.plainText ?? options.text
    return slashCommandChoices(text)[text === options.text ? liveSelection.current : 0]
  }
  const complete = () => {
    const choice = liveChoice()
    if (choice) {
      const value = `/${choice}`
      changeDraft(value, codeUnitOffsetToGraphemeOffset(value, value.length))
    }
  }
  const execute = () => {
    const choice = liveChoice()
    if (!choice) return false
    flushSync(() => {
      controller.changeDraft("", 0)
      controller.dispatchInteraction({ type: "mode.normal" })
      options.onExecute(choice)
    })
    return true
  }
  useBindings(() => ({ priority: 180, bindings: active ? [
    ...["down", "ctrl+n"].map(key => ({ key, cmd: () => move(1) })),
    ...["up", "ctrl+p"].map(key => ({ key, cmd: () => move(-1) })),
    { key: "tab", cmd: complete },
    { key: "return", cmd: execute },
    { key: "escape", cmd: () => flushSync(() => controller.dispatchInteraction({ type: "mode.normal" })) },
  ] : [] }), [active, choices, selected, options.text, controller, options.onExecute])
  const submit = (intent: SubmissionIntent) => {
    const text = options.textareaRef.current?.plainText ?? options.text
    if (interaction.mode === "insert" && text.startsWith("/") && !text.includes("\n")) return execute()
    else controller.submit(intent)
  }
  return { active, choices, selected, changeDraft, submit }
}

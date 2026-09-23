import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import type { SubmissionIntent } from "@vimex/composer"
import { useRef, useState, type RefObject } from "react"
import {
  codeUnitOffsetToGraphemeOffset,
  parseCommand,
  validateCommand,
  type CommandCompletionOptions,
  type InteractionState,
} from "@vimex/interaction"
import type { VimexUiController } from "../contracts"
import { slashCommandChoices } from "./slash-commands"

export function useSlashCommands(options: {
  suspended?: boolean
  text: string
  textareaRef: RefObject<TextareaRenderable | null>
  interaction: InteractionState
  controller: VimexUiController
  completionOptions: CommandCompletionOptions
  onExecute(command: string): void
}) {
  const { interaction, controller } = options
  const active =
    !options.suspended &&
    interaction.mode === "insert" &&
    interaction.surface === "composer" &&
    !interaction.overlay &&
    options.text.startsWith("/") &&
    !options.text.startsWith("//") &&
    !options.text.includes("\n")
  const choices = slashCommandChoices(options.text, options.completionOptions)
  const [selection, setSelection] = useState({
    query: "",
    index: 0,
    chosen: false,
  })
  const [validation, setValidation] = useState({ query: "", message: "" })
  const selected =
    selection.query === options.text
      ? Math.min(selection.index, Math.max(0, choices.length - 1))
      : 0
  const liveSelection = useRef(selected)
  liveSelection.current = selected
  const changeDraft = (text: string, cursor: number) =>
    flushSync(() => controller.changeDraft(text, cursor))
  const move = (delta: number) =>
    flushSync(() => {
      const index = Math.max(
        0,
        Math.min(choices.length - 1, liveSelection.current + delta),
      )
      liveSelection.current = index
      setSelection({ query: options.text, index, chosen: true })
    })
  const liveChoice = () => {
    const text = options.textareaRef.current?.plainText ?? options.text
    return slashCommandChoices(text, options.completionOptions)[
      text === options.text ? liveSelection.current : 0
    ]
  }
  const complete = () => {
    const choice = liveChoice()
    if (choice) {
      const value = `/${choice} `
      const textarea = options.textareaRef.current
      if (textarea) {
        textarea.setText(value)
        textarea.cursorOffset = value.length
      }
      changeDraft(value, codeUnitOffsetToGraphemeOffset(value, value.length))
    }
  }
  const execute = () => {
    const text = options.textareaRef.current?.plainText ?? options.text
    const body = text.slice(1)
    const typed = parseCommand(body)
    const explicitlyChosen =
      selection.query === options.text && selection.chosen
    const completion = slashCommandChoices(text, options.completionOptions)[
      text === options.text ? liveSelection.current : 0
    ]
    const command =
      explicitlyChosen || (typed.kind === "unknown" && completion)
        ? (completion ?? body)
        : body
    const parsed = parseCommand(command)
    const message =
      parsed.kind === "empty"
        ? "Enter a command, or use // for a literal message"
        : parsed.kind === "unknown"
          ? `Unknown command: ${parsed.name}`
          : parsed.name === "submit"
            ? "Use :submit to send the current draft"
            : validateCommand(parsed, options.completionOptions)?.replace(
                /^Usage: :/,
                "Usage: /",
              )
    if (message) {
      flushSync(() => setValidation({ query: text, message }))
      return false
    }
    flushSync(() => {
      controller.changeDraft("", 0)
      controller.dispatchInteraction({ type: "mode.normal" })
      options.onExecute(command.trimEnd())
    })
    return true
  }
  useBindings(
    () => ({
      priority: 180,
      bindings: active
        ? [
            ...["down", "ctrl+n"].map((key) => ({ key, cmd: () => move(1) })),
            ...["up", "ctrl+p"].map((key) => ({ key, cmd: () => move(-1) })),
            { key: "tab", cmd: complete },
            { key: "return", cmd: execute },
            {
              key: "escape",
              cmd: () =>
                flushSync(() =>
                  controller.dispatchInteraction({ type: "mode.normal" }),
                ),
            },
          ]
        : [],
    }),
    [active, choices, selected, options.text, controller, options.onExecute],
  )
  const submit = (intent: SubmissionIntent) => {
    const text = options.textareaRef.current?.plainText ?? options.text
    if (interaction.mode === "insert" && text.startsWith("//")) {
      const literal = text.slice(1)
      const textarea = options.textareaRef.current
      if (textarea) {
        textarea.setText(literal)
        textarea.cursorOffset = literal.length
      }
      flushSync(() =>
        controller.changeDraft(
          literal,
          codeUnitOffsetToGraphemeOffset(literal, literal.length),
        ),
      )
      return controller.submit(intent) !== false
    }
    if (
      interaction.mode === "insert" &&
      text.startsWith("/") &&
      !text.includes("\n")
    )
      return execute()
    return controller.submit(intent) !== false
  }
  const feedback =
    validation.query === options.text ? validation.message : undefined
  return { active, choices, selected, feedback, changeDraft, submit }
}

import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import type { MentionCandidate, MentionKind } from "@vimex/conversation"
import { TelescopePicker } from "@vimex/interaction"
import type { InteractionState } from "@vimex/interaction"
import { useEffect, useRef, useState, type RefObject } from "react"
import type { VimexUiController } from "../contracts"
import type { MentionAttachment } from "@vimex/composer"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemeCount = (text: string) => [...segmenter.segment(text)].length
const codeUnitOffset = (text: string, graphemeOffset: number) =>
  [...segmenter.segment(text)][Math.max(0, graphemeOffset)]?.index ??
  text.length

export function useMentionPicker(options: {
  text: string
  interaction: InteractionState
  textareaRef: RefObject<TextareaRenderable | null>
  controller: VimexUiController
  cwd?: string
  suspended?: boolean
  kind?: MentionKind
  mentions?: readonly MentionAttachment[]
}) {
  const { controller } = options
  const cursor =
    options.textareaRef.current?.cursorOffset ?? options.text.length
  const slash = options.text.match(
    /^\/(files|skills|plugins|grep)(?:\s(.*))?$/u,
  )
  const slashKind: MentionKind | "grep" | undefined =
    slash?.[1] === "files"
      ? "file"
      : slash?.[1] === "skills"
        ? "skill"
        : slash?.[1] === "plugins"
          ? "plugin"
          : slash?.[1] === "grep"
            ? "grep"
            : undefined
  const cursorCodeUnit = codeUnitOffset(options.text, cursor)
  const trigger = options.text.lastIndexOf("@", cursorCodeUnit)
  const attachedMentionAtTrigger = options.mentions?.some((mention) => {
    if (
      !mention.marker ||
      options.text.slice(trigger).startsWith(mention.marker) === false
    )
      return false
    const afterMarker = options.text[trigger + mention.marker.length]
    return afterMarker === undefined || /\s/u.test(afterMarker)
  })
  const active =
    !options.suspended &&
    options.interaction.mode === "insert" &&
    options.interaction.surface === "composer" &&
    !options.interaction.overlay &&
    ((trigger >= 0 &&
      !attachedMentionAtTrigger &&
      !options.text.slice(trigger + 1, cursorCodeUnit).includes("\n")) ||
      Boolean(slashKind))
  const kind = slashKind ?? options.kind ?? "file"
  const query = active
    ? slashKind
      ? (slash?.[2] ?? "")
      : options.text.slice(trigger + 1, cursorCodeUnit)
    : ""
  const [choices, setChoices] = useState<readonly MentionCandidate[]>([])
  const [selected, setSelected] = useState(0)
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set())
  const request = useRef(0)

  useEffect(() => {
    const id = ++request.current
    if (!active || !options.cwd) {
      setChoices([])
      setMarked(new Set())
      return
    }
    // Fetch candidates through the gateway, then apply the same local finder
    // and sorter model used by the Telescope-style picker. Keeping ranking in
    // the UI makes keyboard behavior deterministic across transports and lets
    // remote finders return a broader candidate set without owning ordering.
    const picker = new TelescopePicker<MentionCandidate>({
      finder: () =>
        controller
          .searchMentions(query, kind as MentionKind, options.cwd!)
          .then((result) =>
            result.map((candidate) => ({
              id: `${candidate.kind}:${candidate.path}`,
              text:
                kind === "grep"
                  ? `${candidate.name} ${candidate.detail ?? ""}`
                  : candidate.name,
              detail: candidate.detail,
              value: candidate,
            })),
          ),
    })
    void picker
      .refresh()
      .then(() => {
        const result = picker.setQuery(query).map((entry) => entry.value)
        if (id !== request.current) return
        setChoices(result.slice(0, 50))
        setSelected(0)
        setMarked(new Set())
      })
      .catch(() => {
        if (id !== request.current) return
        setChoices([])
        setSelected(0)
        setMarked(new Set())
      })
    return () => picker.dispose()
  }, [active, controller, kind, options.cwd, query])

  const move = (delta: number) =>
    setSelected((value) =>
      Math.max(0, Math.min(choices.length - 1, value + delta)),
    )
  const mark = () => {
    const choice = choices[selected]
    if (!choice) return
    setMarked((current) => {
      const next = new Set(current)
      if (next.has(choice.path)) next.delete(choice.path)
      else next.add(choice.path)
      return next
    })
  }
  const attach = () => {
    const selectedChoices = choices.filter(
      (choice, index) =>
        marked.has(choice.path) || (!marked.size && index === selected),
    )
    if (!selectedChoices.length) return
    const at =
      options.textareaRef.current?.cursorOffset ?? graphemeCount(options.text)
    // Replace the active trigger/query before inserting the structured mention.
    // Otherwise `@src/co` would remain in the draft and the selected mention
    // would be appended after it.
    const replacementStart = slashKind
      ? 0
      : graphemeCount(options.text.slice(0, trigger))
    const replacementEnd = slashKind ? graphemeCount(options.text) : at
    if (replacementStart !== replacementEnd) {
      const startCodeUnit = codeUnitOffset(options.text, replacementStart)
      const endCodeUnit = codeUnitOffset(options.text, replacementEnd)
      const nextText =
        options.text.slice(0, startCodeUnit) + options.text.slice(endCodeUnit)
      controller.changeDraft(nextText, replacementStart)
    }
    const insertionPoint = replacementStart
    for (const [index, choice] of selectedChoices.entries())
      controller.attachMention(choice, index === 0 ? insertionPoint : undefined)
    const textarea = options.textareaRef.current
    if (textarea) textarea.cursorOffset = textarea.plainText.length
    flushSync(() => {
      controller.dispatchInteraction({ type: "mode.insert" })
      setMarked(new Set())
    })
  }
  const cancel = () => controller.dispatchInteraction({ type: "mode.normal" })
  useBindings(
    () => ({
      priority: 200,
      bindings: active
        ? [
            { key: "down", cmd: () => move(1) },
            { key: "up", cmd: () => move(-1) },
            { key: "tab", cmd: () => move(1) },
            { key: "space", cmd: mark },
            { key: "return", cmd: attach },
            { key: "escape", cmd: cancel },
          ]
        : [],
    }),
    [active, choices, selected, marked, controller],
  )
  return { active, kind, query, choices, selected, marked }
}

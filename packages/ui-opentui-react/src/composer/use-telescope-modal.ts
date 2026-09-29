import { useBindings } from "@opentui/keymap/react"
import type { MentionCandidate, MentionKind } from "@vimex/conversation"
import { TelescopePicker } from "@vimex/interaction"
import { useEffect, useRef, useState } from "react"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { VimexUiController } from "../contracts"

export function useTelescopeModal(options: {
  controller: VimexUiController
  cwd?: string
  cursorOffset?: number
}) {
  const [kind, setKind] = useState<"file" | "grep">("file")
  const [active, setActive] = useState(false)
  const [editing, setEditing] = useState(true)
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<readonly MentionCandidate[]>([])
  const [choices, setChoices] = useState<readonly MentionCandidate[]>([])
  const [selected, setSelected] = useState(0)
  const [markedChoices, setMarkedChoices] = useState<
    ReadonlyMap<string, MentionCandidate>
  >(new Map())
  const inputRef = useRef<InputRenderable>(null)
  const previewScrollRef = useRef<ScrollBoxRenderable>(null)
  // State updates are asynchronous. Global keymap layers can therefore see a
  // key between open() and the next render; this ref lets their commands yield
  // synchronously while the modal owns the keyboard.
  const activeRef = useRef(false)
  const request = useRef(0)
  const filterRequest = useRef(0)
  const open = (next: "file" | "grep") => {
    activeRef.current = true
    setKind(next)
    setEditing(true)
    setQuery("")
    setSelected(0)
    setMarkedChoices(new Map())
    setActive(true)
  }
  const remoteQuery = kind === "grep" ? query : ""
  useEffect(() => {
    const id = ++request.current
    if (!active || !options.cwd) {
      setSource([])
      return
    }
    void options.controller
      .searchMentions(remoteQuery, kind as MentionKind, options.cwd)
      .then((result) => {
        if (id === request.current) setSource(result)
      })
      .catch(() => id === request.current && setSource([]))
  }, [active, kind, options.controller, options.cwd, remoteQuery])
  useEffect(() => {
    const id = ++filterRequest.current
    if (!active) {
      setChoices([])
      return
    }
    const picker = new TelescopePicker<MentionCandidate>({
      finder: () =>
        source.map((candidate) => ({
          id: `${candidate.kind}:${candidate.path}`,
          text: `${candidate.name} ${candidate.detail ?? ""}`,
          detail: candidate.detail,
          value: candidate,
        })),
    })
    void picker
      .refresh()
      .then(() => {
        if (id !== filterRequest.current) return
        // Grep is already filtered by ripgrep's regex query. Fuzzy-scoring the
        // pattern again would hide valid alternatives such as `foo|bar`.
        setChoices(
          picker
            .setQuery(kind === "grep" ? "" : query)
            .map((entry) => entry.value),
        )
        setSelected(0)
      })
      .catch(() => id === filterRequest.current && setChoices([]))
    return () => picker.dispose()
  }, [active, kind, query, source])
  useEffect(() => {
    if (active && editing) inputRef.current?.focus()
    else inputRef.current?.blur()
  }, [active, editing])
  useEffect(() => {
    previewScrollRef.current?.scrollTo(0)
  }, [active, choices, selected])
  const close = () => {
    activeRef.current = false
    setActive(false)
  }
  const move = (delta: number) =>
    setSelected((value) =>
      Math.max(0, Math.min(Math.max(0, choices.length - 1), value + delta)),
    )
  const toggle = () => {
    const choice = choices[selected]
    if (!choice) return
    setMarkedChoices((current) => {
      const next = new Map(current)
      if (next.has(choice.path)) next.delete(choice.path)
      else next.set(choice.path, choice)
      return next
    })
  }
  const attach = () => {
    const selectedChoices = markedChoices.size
      ? [...markedChoices.values()]
      : choices[selected]
        ? [choices[selected]!]
        : []
    for (const [index, choice] of selectedChoices.entries())
      options.controller.attachMention(
        choice,
        index === 0 ? options.cursorOffset : undefined,
      )
    if (selectedChoices.length) {
      options.controller.dispatchInteraction({ type: "mode.insert" })
      close()
    }
  }
  useBindings(
    () => ({
      priority: 250,
      bindings: active
        ? [
            { key: "down", cmd: () => move(1) },
            { key: "up", cmd: () => move(-1) },
            { key: "tab", cmd: () => move(1) },
            ...(editing
              ? []
              : [
                  { key: "space", cmd: toggle },
                  { key: "j", cmd: () => move(1) },
                  { key: "k", cmd: () => move(-1) },
                  { key: "i", cmd: () => setEditing(true) },
                  { key: "/", cmd: () => setEditing(true) },
                ]),
            {
              key: "ctrl+e",
              cmd: () => previewScrollRef.current?.scrollBy(1, "step"),
            },
            {
              key: "ctrl+y",
              cmd: () => previewScrollRef.current?.scrollBy(-1, "step"),
            },
            {
              key: "ctrl+d",
              cmd: () => previewScrollRef.current?.scrollBy(0.5, "viewport"),
            },
            {
              key: "ctrl+u",
              cmd: () => previewScrollRef.current?.scrollBy(-0.5, "viewport"),
            },
            { key: "return", cmd: attach },
            {
              key: "escape",
              cmd: () => (editing ? setEditing(false) : close()),
            },
            { key: "ctrl+c", cmd: close },
          ]
        : [],
    }),
    [
      active,
      editing,
      choices,
      selected,
      markedChoices,
      options.controller,
      options.cursorOffset,
    ],
  )
  return {
    active,
    editing,
    kind,
    query,
    setQuery,
    choices,
    selected,
    marked: new Set(markedChoices.keys()),
    preview: choices[selected]?.preview ?? choices[selected]?.detail,
    previewPath: choices[selected]?.path,
    inputRef,
    previewScrollRef,
    activeRef,
    open,
    close,
  }
}

import { useBindings } from "@opentui/keymap/react"
import type { MentionCandidate } from "@vimex/conversation"
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
  const [loadedPreview, setLoadedPreview] = useState<{
    path: string
    text: string | undefined
  }>()
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
    const abort = new AbortController()
    setSource([])
    void options.controller
      .searchMentions(remoteQuery, kind, options.cwd, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted && id === request.current) setSource(result)
      })
      .catch(() => {
        if (!abort.signal.aborted && id === request.current) setSource([])
      })
    return () => abort.abort()
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
        // Grep is already filtered by the gateway's regex query. Fuzzy-scoring the
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
  const choice = active ? choices[selected] : undefined
  const previewPath = choice?.path
  const filePreviewPath = choice?.kind === "file" ? previewPath : undefined
  const inlinePreview = choice?.preview
  useEffect(() => {
    setLoadedPreview(undefined)
    if (!filePreviewPath || inlinePreview !== undefined) return
    const abort = new AbortController()
    void options.controller
      .readMentionPreview?.(filePreviewPath, abort.signal)
      .then((text) => {
        if (!abort.signal.aborted)
          setLoadedPreview({ path: filePreviewPath, text })
      })
      .catch(() => {
        // Missing, binary, or unreadable files keep the metadata fallback.
      })
    return () => abort.abort()
  }, [filePreviewPath, inlinePreview, options.controller])
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
    preview:
      inlinePreview ??
      (loadedPreview?.path === filePreviewPath
        ? loadedPreview?.text
        : undefined) ??
      choice?.detail,
    previewPath,
    inputRef,
    previewScrollRef,
    activeRef,
    open,
    close,
  }
}

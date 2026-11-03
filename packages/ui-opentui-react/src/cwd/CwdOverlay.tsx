import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { directoryArgument, type WorkbenchState } from "@vimex/workbench"
import { OverlayFrame } from "../app/OverlayFrame"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { emberTide } from "../theme"

export function CwdOverlay(props: {
  picker: NonNullable<WorkbenchState["cwdPicker"]>
  onBrowse(directory?: string): void
  onChoose(cwd: string): void
  onClose(): void
}) {
  const { picker } = props
  const geometry = usePaneGeometry()
  const [editing, setEditing] = useState<"filter" | "path">()
  const [query, setQuery] = useState("")
  const [path, setPath] = useState("")
  const [selectedId, setSelectedId] = useState<string>()
  const [feedback, setFeedback] = useState("")
  const inputRef = useRef<InputRenderable>(null)
  const listRef = useRef<ScrollBoxRenderable>(null)
  const initialized = useRef(false)
  const completion = useRef<
    | {
        prefix: string
        previous: typeof picker.listing
      }
    | undefined
  >(undefined)
  const rows = useMemo(
    () =>
      (picker.listing?.entries ?? []).filter((row) =>
        `${row.label} ${row.cwd}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [picker.listing, query],
  )
  const selected = rows.find((row) => row.cwd === selectedId) ?? rows[0]
  useEffect(() => {
    if (!picker.listing) return
    if (!initialized.current) {
      initialized.current = true
      setSelectedId(rows[0]?.cwd)
    }
  }, [picker.listing, rows])
  useEffect(() => {
    if (selected && !rows.some((row) => row.cwd === selectedId))
      setSelectedId(selected.cwd)
    const index = rows.findIndex((row) => row.cwd === selected?.cwd)
    if (index >= 0) listRef.current?.scrollTo(index)
  }, [rows, selected?.cwd, selectedId])
  useEffect(() => {
    const request = completion.current
    if (!request || picker.loading) return
    if (picker.error) {
      completion.current = undefined
      return
    }
    if (!picker.listing || picker.listing === request.previous) return
    completion.current = undefined
    const matches = picker.listing.entries.filter(
      (row) =>
        row.cwd !== picker.listing!.directory &&
        row.cwd.split("/").at(-1)?.startsWith(request.prefix),
    )
    if (matches.length === 1) {
      const value = `${matches[0]!.cwd}/`
      setPath(value)
      if (inputRef.current) {
        inputRef.current.value = value
        inputRef.current.cursorOffset = value.length
      }
      setFeedback("")
    } else {
      setQuery(request.prefix)
      setFeedback(
        matches.length
          ? "Several matches; Esc then choose a directory."
          : "No matching directories.",
      )
    }
  }, [picker.listing, picker.loading, picker.error])
  const focus = () => {
    inputRef.current?.focus()
    if (inputRef.current)
      inputRef.current.cursorOffset = inputRef.current.value.length
  }
  const edit = (kind: "filter" | "path") => {
    flushSync(() => {
      setEditing(kind)
      setFeedback("")
      if (kind === "path") setPath(picker.listing?.directory ?? "~")
    })
    focus()
  }
  const resolveDirectory = (input: string) => {
    const value = directoryArgument(input)
    return value.startsWith("/") || value.startsWith("~")
      ? value
      : `${picker.listing?.directory ?? "."}/${value}`
  }
  const browse = (directory?: string) => {
    setQuery("")
    setFeedback("")
    setSelectedId(undefined)
    props.onBrowse(directory)
  }
  const activate = () => {
    if (picker.loading || !selected) return
    browse(selected.cwd)
  }
  const submit = () => {
    if (picker.loading) return
    if (editing === "path") {
      const value = (inputRef.current?.value ?? path).trim()
      completion.current = undefined
      if (value) {
        const resolved = resolveDirectory(value)
        setPath(resolved)
        if (inputRef.current) inputRef.current.value = resolved
        browse(resolved)
      }
    } else activate()
  }
  const completePath = () => {
    if (picker.loading) return
    const value = resolveDirectory((inputRef.current?.value ?? path).trim())
    const slash = value.lastIndexOf("/")
    const parent = slash < 0 ? "." : value.slice(0, slash) || "/"
    completion.current = {
      prefix: slash < 0 ? value : value.slice(slash + 1),
      previous: picker.listing,
    }
    props.onBrowse(parent)
  }
  const move = (delta: number) => {
    const index = rows.findIndex((row) => row.cwd === selected?.cwd)
    setSelectedId(
      rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.cwd,
    )
  }
  useBindings(
    () => ({
      priority: 250,
      bindings: [
        {
          key: "escape",
          cmd: () => {
            if (editing) {
              setEditing(undefined)
              completion.current = undefined
              inputRef.current?.blur()
            } else props.onClose()
          },
        },
        {
          key: "ctrl+return",
          cmd: () => {
            if (!picker.loading && picker.listing?.directory)
              props.onChoose(picker.listing.directory)
          },
        },
        ...["down", "ctrl+n"].map((key) => ({ key, cmd: () => move(1) })),
        ...["up", "ctrl+p"].map((key) => ({ key, cmd: () => move(-1) })),
        ...(editing
          ? [
              {
                key: "tab",
                cmd: () => (editing === "path" ? completePath() : undefined),
              },
              { key: "ctrl+f", cmd: () => {} },
            ]
          : [
              { key: "return", cmd: activate },
              { key: "j", cmd: () => move(1) },
              { key: "k", cmd: () => move(-1) },
              { key: "/", cmd: () => edit("filter") },
              { key: "i", cmd: () => edit("filter") },
              { key: "p", cmd: () => edit("path") },
              {
                key: "b",
                cmd: () => {
                  if (!picker.loading && picker.listing?.parent)
                    browse(picker.listing.parent)
                },
              },
              {
                key: "w",
                cmd: () => {
                  if (!picker.loading) browse()
                },
              },
              {
                key: "u",
                cmd: () => {
                  if (!picker.loading && picker.listing?.directory)
                    props.onChoose(picker.listing.directory)
                },
              },
            ]),
      ],
    }),
    [
      editing,
      selected,
      rows,
      path,
      picker,
      props.onBrowse,
      props.onChoose,
      props.onClose,
    ],
  )
  return (
    <OverlayFrame title="Working directory" width={96}>
      <text
        height={1}
        flexShrink={0}
        fg={emberTide.textMuted}
        wrapMode="none"
        truncate
      >
        Browse, then choose the displayed directory.
      </text>
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={emberTide.amber}>{editing === "path" ? "Path: " : "/ "}</text>
        {editing ? (
          <input
            id="cwd-input"
            key={editing}
            ref={inputRef}
            focused
            flexGrow={1}
            value={editing === "path" ? path : query}
            onInput={(value) => {
              if (editing === "path") {
                // A delayed completion must never overwrite text typed since Tab.
                completion.current = undefined
                setPath(value)
              } else setQuery(value)
            }}
            onSubmit={submit}
            textColor={emberTide.text}
            backgroundColor={emberTide.backgroundPanel}
            focusedBackgroundColor={emberTide.backgroundPanel}
          />
        ) : (
          <text
            height={1}
            flexShrink={0}
            fg={emberTide.textMuted}
            wrapMode="none"
            truncate
          >
            {query || "Filter directories · p enter path"}
          </text>
        )}
      </box>
      <text
        height={1}
        flexShrink={0}
        fg={emberTide.textMuted}
        wrapMode="none"
        truncate
      >
        {picker.listing?.directory ?? picker.cwd}
      </text>
      <scrollbox
        ref={listRef}
        maxHeight={Math.max(2, Math.min(12, geometry.height - 14))}
        flexShrink={1}
      >
        {rows.map((row) => (
          <box
            key={row.cwd}
            height={1}
            flexShrink={0}
            backgroundColor={
              row.cwd === selected?.cwd
                ? emberTide.selection
                : emberTide.backgroundRaised
            }
          >
            <text
              wrapMode="none"
              truncate
              fg={
                row.cwd === selected?.cwd
                  ? emberTide.selectionText
                  : emberTide.text
              }
            >
              {row.cwd === selected?.cwd ? "> " : "  "}
              {row.label}/
            </text>
          </box>
        ))}
        {!rows.length && !picker.loading ? (
          <text
            height={1}
            flexShrink={0}
            fg={emberTide.textMuted}
            wrapMode="none"
            truncate
          >
            No matching directories
          </text>
        ) : null}
      </scrollbox>
      <text
        height={1}
        flexShrink={0}
        fg={emberTide.textMuted}
        wrapMode="none"
        truncate
      >
        {editing === "path"
          ? "Enter browse · Tab complete · Esc finish editing"
          : editing
            ? "Enter browse · Esc finish searching"
            : "Enter browse · u / Ctrl-Enter use current"}
      </text>
      {!editing ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.textMuted}
          wrapMode="none"
          truncate
        >
          p path · / filter · b parent · Esc close
        </text>
      ) : null}
      {picker.loading ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.amber}
          wrapMode="none"
          truncate
        >
          Loading directories…
        </text>
      ) : null}
      {picker.error || feedback ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.amber}
          wrapMode="none"
          truncate
        >
          {picker.error ?? feedback}
        </text>
      ) : null}
    </OverlayFrame>
  )
}

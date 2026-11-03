import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { directoryArgument, type WorkbenchState } from "@vimex/workbench"
import { OverlayFrame } from "../app/OverlayFrame"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { emberTide } from "../theme"

export function HandoffOverlay(props: {
  picker: NonNullable<WorkbenchState["handoffPicker"]>
  onBrowse(directory?: string): void
  onChoose(cwd?: string, isolated?: boolean): void
  onFavorite(cwd: string): void
  onClose(): void
}) {
  const { picker } = props
  const geometry = usePaneGeometry()
  const busy = Boolean(picker.transferring)
  const [editing, setEditing] = useState<"filter" | "path">()
  const [query, setQuery] = useState("")
  const [path, setPath] = useState("")
  const [selectedId, setSelectedId] = useState<string>()
  const [feedback, setFeedback] = useState("")
  const inputRef = useRef<InputRenderable>(null)
  const listRef = useRef<ScrollBoxRenderable>(null)
  const errorRef = useRef<ScrollBoxRenderable>(null)
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
      (picker.listing?.entries ?? [])
        .filter((row) =>
          `${row.label} ${row.cwd} ${row.branch ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice()
        .sort(
          (a, b) =>
            Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
            Number(Boolean(b.recent)) - Number(Boolean(a.recent)),
        ),
    [picker.listing, query],
  )
  const selected =
    rows.find((row) => row.cwd === selectedId) ??
    (!initialized.current
      ? rows.find((row) => row.cwd === picker.listing?.preferredCwd)
      : undefined) ??
    rows[0]
  const pathRows = Math.min(
    2,
    Math.max(
      1,
      Math.ceil(
        (selected?.cwd.length ?? 0) /
          Math.max(1, Math.min(82, geometry.width - 14)),
      ),
    ),
  )
  const ready = selected?.kind === "worktree" && selected.dirty === false
  const readiness =
    selected?.kind !== "worktree"
      ? "Browse to a matching repository root"
      : selected.dirty === true
        ? "Modified — commit or stash before handoff"
        : selected.dirty === undefined
          ? "Status unavailable — refresh before handoff"
          : "Ready — handoff will use this workspace"
  const choose = () => {
    if (editing === "path") {
      setFeedback(
        "Enter browses this path; Esc returns to workspace selection.",
      )
      return
    }
    if (!busy && !picker.loading && !picker.preflightError && ready && selected)
      props.onChoose(selected.cwd)
  }
  useEffect(() => {
    if (!picker.listing) return
    if (!initialized.current) {
      initialized.current = true
      setSelectedId(picker.listing.preferredCwd ?? rows[0]?.cwd)
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
      const names = matches.map((row) => row.cwd.split("/").at(-1)!)
      let common = names[0] ?? ""
      for (const name of names.slice(1)) {
        while (!name.startsWith(common)) common = common.slice(0, -1)
      }
      if (common.length > request.prefix.length) {
        const value = `${picker.listing.directory.replace(/\/$/, "")}/${common}`
        setPath(value)
        if (inputRef.current) {
          inputRef.current.value = value
          inputRef.current.cursorOffset = value.length
        }
      }
      setQuery(request.prefix)
      setFeedback(
        matches.length
          ? "Several matches; Esc to browse matching folders."
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
    if (busy || picker.loading || picker.preflightError || !selected) return
    browse(selected.cwd)
  }
  const submit = () => {
    if (busy || picker.loading || picker.preflightError) return
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
    if (busy || picker.loading || picker.preflightError) return
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
            if (busy) return
            if (picker.preflightError) {
              props.onClose()
              return
            }
            if (editing) {
              setEditing(undefined)
              completion.current = undefined
              inputRef.current?.blur()
            } else props.onClose()
          },
        },
        { key: "ctrl+return", cmd: choose },
        ...(busy
          ? [
              "return",
              "tab",
              "up",
              "down",
              "ctrl+n",
              "ctrl+p",
              "j",
              "k",
              "i",
              "/",
              "p",
              "b",
              "w",
              "u",
              "n",
              "ctrl+f",
            ].map((key) => ({ key, cmd: () => {} }))
          : picker.preflightError
            ? [
                {
                  key: "w",
                  cmd: () => {
                    if (!picker.loading) browse()
                  },
                },
                ...["j", "down", "ctrl+n"].map((key) => ({
                  key,
                  cmd: () => errorRef.current?.scrollBy(1, "step"),
                })),
                ...["k", "up", "ctrl+p"].map((key) => ({
                  key,
                  cmd: () => errorRef.current?.scrollBy(-1, "step"),
                })),
                ...[
                  "return",
                  "tab",
                  "i",
                  "/",
                  "p",
                  "b",
                  "u",
                  "n",
                  "ctrl+f",
                ].map((key) => ({ key, cmd: () => {} })),
              ]
            : [
                ...["down", "ctrl+n"].map((key) => ({
                  key,
                  cmd: () => move(1),
                })),
                ...["up", "ctrl+p"].map((key) => ({
                  key,
                  cmd: () => move(-1),
                })),
                ...(editing
                  ? [
                      {
                        key: "tab",
                        cmd: () =>
                          editing === "path" ? completePath() : undefined,
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
                          if (
                            !picker.loading &&
                            !picker.preflightError &&
                            picker.listing?.parent
                          )
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
                          choose()
                        },
                      },
                      {
                        key: "n",
                        cmd: () => {
                          if (
                            !picker.loading &&
                            !picker.preflightError &&
                            selected?.kind === "worktree"
                          )
                            props.onChoose(selected.cwd, true)
                        },
                      },
                      {
                        key: "ctrl+f",
                        cmd: () => {
                          if (!picker.loading && selected?.kind === "worktree")
                            props.onFavorite(selected.cwd)
                        },
                      },
                    ]),
              ]),
      ],
    }),
    [
      editing,
      selected,
      rows,
      path,
      picker,
      busy,
      ready,
      props.onBrowse,
      props.onChoose,
      props.onFavorite,
      props.onClose,
    ],
  )
  if (picker.preflightError)
    return (
      <OverlayFrame title={`Handoff to ${picker.targetId}`} width={96}>
        <text height={1} flexShrink={0} fg={emberTide.amber}>
          Handoff unavailable
        </text>
        <scrollbox
          ref={errorRef}
          maxHeight={Math.max(2, Math.floor(geometry.height * 0.85) - 6)}
          flexShrink={1}
        >
          <text fg={emberTide.amber} wrapMode="word" flexShrink={0}>
            {picker.error}
          </text>
        </scrollbox>
        <text height={1} flexShrink={0} fg={emberTide.textMuted}>
          w retry · j/k scroll · Esc close
        </text>
      </OverlayFrame>
    )
  return (
    <OverlayFrame title={`Handoff to ${picker.targetId}`} width={96}>
      <text
        height={1}
        flexShrink={0}
        fg={emberTide.textMuted}
        wrapMode="none"
        truncate
      >
        Browse, then hand off to a clean workspace.
      </text>
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={emberTide.amber}>{editing === "path" ? "Path: " : "/ "}</text>
        {editing ? (
          <input
            id="handoff-input"
            key={editing}
            ref={inputRef}
            focused={!busy}
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
            {query || "Search workspaces · p enter path"}
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
        maxHeight={Math.max(
          1,
          Math.min(
            12,
            geometry.height -
              17 -
              (pathRows - 1) -
              (picker.error || feedback ? 2 : 0) -
              (busy || picker.loading ? 1 : 0),
          ),
        )}
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
              {row.favorite ? "★ " : ""}
              {row.label}
              {row.recent && !row.favorite ? " · recent" : ""}
              {row.kind === "directory" ? "/" : ""}
              {row.branch ? ` · ${row.branch}` : ""}
              {row.dirty === true
                ? " · modified"
                : row.dirty === false
                  ? " · clean"
                  : row.kind === "worktree"
                    ? " · status unknown"
                    : ""}
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
            No matching workspaces
          </text>
        ) : null}
      </scrollbox>
      <text
        height={pathRows}
        flexShrink={0}
        fg={emberTide.text}
        wrapMode="char"
      >
        {selected?.cwd ?? "Select a destination"}
      </text>
      <text
        height={1}
        flexShrink={0}
        fg={ready ? emberTide.sage : emberTide.amber}
        wrapMode="none"
        truncate
      >
        {selected?.branch ? `${selected.branch} · ` : ""}
        {readiness}
      </text>
      {!busy && editing !== "path" && (!editing || ready) ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.blueBright}
          wrapMode="none"
          truncate
        >
          {editing === "filter"
            ? "Esc, then u to hand off"
            : selected?.kind === "worktree"
              ? `${ready ? "u Handoff here · " : ""}n New isolated`
              : "Select a repository for a new worktree"}
        </text>
      ) : null}
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
            : "Enter browse · Ctrl-F favorite"}
      </text>
      {!editing ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.textMuted}
          wrapMode="none"
          truncate
        >
          p path · / find · b up · w saved · Esc close
        </text>
      ) : null}
      {picker.loading || busy ? (
        <text
          height={1}
          flexShrink={0}
          fg={emberTide.amber}
          wrapMode="none"
          truncate
        >
          {busy
            ? `${picker.phase ?? "Preparing"} handoff…`
            : picker.phase === "checking"
              ? "Checking handoff support…"
              : "Loading destinations…"}
        </text>
      ) : null}
      {picker.error || feedback ? (
        <text height={2} flexShrink={0} fg={emberTide.amber} wrapMode="word">
          {picker.error ?? feedback}
        </text>
      ) : null}
    </OverlayFrame>
  )
}

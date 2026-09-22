import { usePaneGeometry } from "../side-chat/pane-geometry"
import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { ThreadId } from "@vimex/conversation"
import { useEffect, useRef, useState, type RefObject } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"
import { sessionRecency, type SessionRow } from "./session-search"

export function SessionsOverlay(props: {
  scope?: string
  onToggleScope?(): void
  rows: readonly SessionRow[]
  query: string
  searchEditing?: boolean
  onSearchEditing?(editing: boolean): void
  onMove?(delta: number): void
  searchRef: RefObject<InputRenderable | null>
  onQuery(value: string): void
  onSubmit(): void
  active?: ThreadId
  selected: number
  onRename?(id: ThreadId, title: string): void
  onFavorite?(id: ThreadId): void
}) {
  const [renaming, setRenaming] = useState<{ id: ThreadId; title: string }>()
  const renameRef = useRef<InputRenderable>(null)
  const cancelRename = () => {
    flushSync(() => setRenaming(undefined))
    props.searchRef.current?.focus()
  }
  const saveRename = () => {
    const title = renameRef.current?.value.trim()
    if (!renaming || !title) return
    props.onRename?.(renaming.id, title)
    cancelRename()
  }
  useBindings(
    () => ({
      priority: 250,
      bindings: renaming
        ? [
            { key: "escape", cmd: cancelRename },
            ...["ctrl+f", "ctrl+r", "up", "down", "ctrl+n", "ctrl+p"].map(
              (key) => ({ key, cmd: () => {} }),
            ),
          ]
        : [
            { key: "tab", cmd: () => props.onToggleScope?.() },
            ...(props.searchEditing
              ? [{ key: "escape", cmd: () => props.onSearchEditing?.(false) }]
              : [
                  { key: "j", cmd: () => props.onMove?.(1) },
                  { key: "k", cmd: () => props.onMove?.(-1) },
                  { key: "i", cmd: () => props.onSearchEditing?.(true) },
                  { key: "/", cmd: () => props.onSearchEditing?.(true) },
                ]),
            {
              key: "ctrl+f",
              cmd: () => {
                const row = props.rows[props.selected]
                if (row) props.onFavorite?.(row.id)
              },
            },
            {
              key: "ctrl+r",
              cmd: () => {
                const row = props.rows[props.selected]
                if (!row) return
                flushSync(() =>
                  setRenaming({ id: row.id, title: row.summary?.title ?? "" }),
                )
                renameRef.current?.focus()
                if (renameRef.current)
                  renameRef.current.cursorOffset =
                    renameRef.current.value.length
              },
            },
          ],
    }),
    [
      renaming,
      props.rows,
      props.selected,
      props.onFavorite,
      props.onRename,
      props.searchEditing,
      props.onSearchEditing,
      props.onMove,
      props.onToggleScope,
    ],
  )
  const narrow = usePaneGeometry().width < 100
  const listRef = useRef<ScrollBoxRenderable>(null)
  const selectedId = props.rows[props.selected]?.id
  useEffect(() => {
    const list = listRef.current
    if (!selectedId || !list) return
    list.scrollChildIntoView(`session-row:${selectedId}`)
    list.requestRender()
  }, [selectedId])
  return (
    <OverlayFrame title="Sessions" width={92}>
      {props.scope ? (
        <text id="session-scope" height={1} fg={emberTide.amber}>
          {props.scope} · Tab toggle scope
        </text>
      ) : null}
      {renaming ? (
        <box height={1} flexDirection="row">
          <text fg={emberTide.amber}>Rename: </text>
          <input
            key="rename"
            id="session-rename"
            ref={renameRef}
            focused
            flexGrow={1}
            value={renaming.title}
            onInput={(title) =>
              setRenaming((current) =>
                current ? { ...current, title } : current,
              )
            }
            onSubmit={saveRename}
            textColor={emberTide.text}
            backgroundColor={emberTide.backgroundPanel}
            focusedBackgroundColor={emberTide.backgroundPanel}
          />
        </box>
      ) : (
        <box height={1} flexDirection="row">
          <text fg={emberTide.blueBright}>/ </text>
          <input
            key="search"
            id="session-search"
            ref={props.searchRef}
            flexGrow={1}
            focused
            value={props.query}
            placeholder="fuzzy search title, cwd, branch…"
            textColor={emberTide.text}
            cursorColor={emberTide.blueBright}
            backgroundColor={emberTide.backgroundPanel}
            focusedBackgroundColor={emberTide.backgroundPanel}
            onInput={(value) => {
              if (!props.searchEditing) props.onSearchEditing?.(true)
              props.onQuery(value)
            }}
            onSubmit={props.onSubmit}
          />
        </box>
      )}
      <text fg={emberTide.textMuted}>
        {renaming
          ? "enter save · esc cancel rename"
          : props.searchEditing
            ? "INSERT search · ↑/↓ move · enter open · esc normal"
            : "j/k move · i search · enter open · ctrl-r rename · ctrl-f favorite · esc close"}
      </text>
      <scrollbox ref={listRef} flexGrow={1} minHeight={5} marginTop={1}>
        {props.rows.map(({ id, summary, favorite }, index) => {
          const current = index === props.selected
          return (
            <box
              id={`session-row:${id}`}
              key={id}
              height={narrow ? 4 : 3}
              flexShrink={0}
              backgroundColor={
                current ? emberTide.selection : emberTide.backgroundRaised
              }
              paddingX={1}
            >
              <box height={1} flexDirection="row" gap={1}>
                <text
                  id={`session-title:${id}`}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  fg={current ? emberTide.selectionText : emberTide.text}
                  wrapMode="none"
                  truncate
                >
                  {favorite ? "★ " : ""}
                  {summary?.status === "working"
                    ? "◌ "
                    : id === props.active
                      ? "● "
                      : "  "}
                  {summary?.title ?? id}
                </text>
                {!narrow ? (
                  <text
                    flexShrink={0}
                    fg={
                      summary?.status === "working"
                        ? emberTide.blueBright
                        : emberTide.textMuted
                    }
                  >
                    {summary?.status ?? ""} {sessionRecency(summary?.updatedAt)}
                  </text>
                ) : null}
              </box>
              <box height={1} flexDirection="row" gap={1}>
                <text
                  id={`session-cwd:${id}`}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  fg={emberTide.textMuted}
                  wrapMode="none"
                  truncate
                >
                  {summary?.cwd ?? ""}
                </text>
                {!narrow ? (
                  <text flexShrink={0} fg={emberTide.textMuted} wrapMode="none">
                    {summary?.gitBranch ? `git:${summary.gitBranch}` : ""}{" "}
                    {summary?.model ?? ""}
                  </text>
                ) : null}
              </box>
              {narrow ? (
                <text
                  id={`session-metadata:${id}`}
                  height={1}
                  fg={emberTide.textMuted}
                  wrapMode="none"
                  truncate
                >
                  {[
                    summary?.status,
                    summary?.gitBranch ? `git:${summary.gitBranch}` : undefined,
                    summary?.model,
                    sessionRecency(summary?.updatedAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              ) : null}
            </box>
          )
        })}
        {props.rows.length === 0 ? (
          <text fg={emberTide.textMuted}>No matching sessions</text>
        ) : null}
      </scrollbox>
    </OverlayFrame>
  )
}

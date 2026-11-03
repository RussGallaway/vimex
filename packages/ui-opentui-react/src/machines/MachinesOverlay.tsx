import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { flushSync } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { MachineInfo } from "@vimex/workbench"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"
import { usePaneGeometry } from "../side-chat/pane-geometry"

type Form =
  | { kind: "rename"; id: string; value: string }
  | { kind: "add-name"; value: string }
  | { kind: "add-host"; id: string; value: string }
  | { kind: "remove"; id: string; value: string }

export function MachinesOverlay(props: {
  machines: readonly MachineInfo[]
  active?: string
  management?: { pending: boolean; error?: string }
  onCommand(command: string): void
  onClose(): void
}) {
  const geometry = usePaneGeometry()
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [form, setForm] = useState<Form>()
  const [error, setError] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const awaitingResult = useRef(false)
  const inputRef = useRef<InputRenderable>(null)
  const listRef = useRef<ScrollBoxRenderable>(null)
  const rows = useMemo(
    () =>
      props.machines
        .filter((machine) =>
          `${machine.label ?? ""} ${machine.id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort(
          (a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)),
        ),
    [props.machines, query],
  )
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0]
  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id)
    if (selected)
      listRef.current?.scrollChildIntoView(`machine-row:${selected.id}`)
  }, [selected?.id, selectedId])
  useEffect(() => {
    const index = rows.findIndex((row) => row.id === selected?.id)
    if (index >= 0) listRef.current?.scrollTo(index)
  }, [rows])
  const focusInput = () => {
    inputRef.current?.focus()
    if (inputRef.current)
      inputRef.current.cursorOffset = inputRef.current.value.length
  }
  const openForm = (next: Form) => {
    flushSync(() => {
      setForm(next)
      setError("")
    })
    if (next.kind !== "remove") focusInput()
  }
  const cancel = () => {
    flushSync(() => {
      setForm(undefined)
      setError("")
      setSearching(false)
    })
    inputRef.current?.blur()
  }
  useEffect(() => {
    if (
      !awaitingResult.current ||
      !props.management ||
      props.management.pending
    )
      return
    awaitingResult.current = false
    setSubmitted(false)
    if (props.management.error) setError(props.management.error)
    else cancel()
  }, [props.management])
  const command = (value: string) => {
    if (submitted || props.management?.pending) return
    awaitingResult.current = true
    flushSync(() => {
      setSubmitted(true)
      setError("")
    })
    props.onCommand(value)
  }
  const move = (delta: number) => {
    const index = rows.findIndex((row) => row.id === selected?.id)
    setSelectedId(
      rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.id,
    )
  }
  const choose = () => {
    if (selected) props.onCommand(`machine ${selected.id}`)
  }
  const submit = () => {
    if (submitted || props.management?.pending) return
    if (!form) {
      choose()
      return
    }
    const value = (inputRef.current?.value ?? form.value).trim()
    if (form.kind === "remove") {
      command(`machine remove ${form.id}`)
    } else if (form.kind === "add-name") {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
        setError(
          "Use a name with letters, numbers, dots, underscores, or hyphens.",
        )
        return
      }
      openForm({ kind: "add-host", id: value, value })
      return
    } else if (form.kind === "add-host") {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(value)) {
        setError("Enter an SSH alias or user@host.")
        return
      }
      command(`machine add ${form.id} ${value}`)
    } else {
      if (!value) {
        setError("Enter a display name.")
        return
      }
      command(`machine rename ${form.id} ${value}`)
    }
  }
  const rename = () => {
    if (selected?.id === "local" || !selected) {
      setError("The local machine name is fixed.")
      return
    }
    openForm({
      kind: "rename",
      id: selected.id,
      value: selected.label ?? selected.id,
    })
  }
  const remove = () => {
    if (!selected) return
    if (selected.id === "local") {
      setError("The local connection cannot be removed.")
      return
    }
    if (selected.id === props.active) {
      setError("Switch to another machine before removing this connection.")
      return
    }
    openForm({
      kind: "remove",
      id: selected.id,
      value: selected.label ?? selected.id,
    })
  }
  useBindings(
    () => ({
      priority: 250,
      bindings: [
        {
          key: "escape",
          cmd: () =>
            submitted || props.management?.pending
              ? undefined
              : form || searching
                ? cancel()
                : props.onClose(),
        },
        ...(submitted || props.management?.pending
          ? [
              "return",
              "ctrl+f",
              "ctrl+r",
              "ctrl+n",
              "ctrl+p",
              "up",
              "down",
              "j",
              "k",
              "a",
              "r",
              "d",
              "h",
              "i",
              "/",
            ].map((key) => ({ key, cmd: () => {} }))
          : form
            ? [
                ...(form.kind === "remove"
                  ? [{ key: "return", cmd: submit }]
                  : []),
                ...["ctrl+f", "ctrl+r", "ctrl+n", "ctrl+p", "up", "down"].map(
                  (key) => ({ key, cmd: () => {} }),
                ),
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
                {
                  key: "ctrl+f",
                  cmd: () => {
                    if (selected) command(`machine favorite ${selected.id}`)
                  },
                },
                { key: "ctrl+r", cmd: rename },
                ...(!searching
                  ? [
                      { key: "j", cmd: () => move(1) },
                      { key: "k", cmd: () => move(-1) },
                      { key: "return", cmd: choose },
                      ...["i", "/"].map((key) => ({
                        key,
                        cmd: () => {
                          flushSync(() => setSearching(true))
                          focusInput()
                        },
                      })),
                      {
                        key: "a",
                        cmd: () => openForm({ kind: "add-name", value: "" }),
                      },
                      { key: "r", cmd: rename },
                      { key: "d", cmd: remove },
                      {
                        key: "h",
                        cmd: () => {
                          if (!selected) return
                          // Validation may reject before opening the destination
                          // picker; close this modal so its notice stays visible.
                          props.onClose()
                          props.onCommand(`handoff ${selected.id}`)
                        },
                      },
                    ]
                  : []),
              ]),
      ],
    }),
    [
      form,
      searching,
      selected,
      rows,
      props.onCommand,
      props.onClose,
      submitted,
      props.management,
    ],
  )
  const input = form?.kind !== "remove" && (form || searching)
  return (
    <OverlayFrame title="Machines" width={80}>
      <box height={1} flexDirection="row">
        <text fg={emberTide.amber}>
          {form?.kind === "rename"
            ? "Display name: "
            : form?.kind === "add-name"
              ? "Machine ID: "
              : form?.kind === "add-host"
                ? `SSH host (${form.id}): `
                : form?.kind === "remove"
                  ? "Remove connection"
                  : "/ "}
        </text>
        {input ? (
          <input
            key={form?.kind ?? "search"}
            id="machine-input"
            ref={inputRef}
            focused={!submitted && !props.management?.pending}
            flexGrow={1}
            value={form?.value ?? query}
            onInput={(value) =>
              form ? setForm({ ...form, value }) : setQuery(value)
            }
            onSubmit={submit}
            textColor={emberTide.text}
            backgroundColor={emberTide.backgroundPanel}
            focusedBackgroundColor={emberTide.backgroundPanel}
          />
        ) : (
          <text fg={emberTide.textMuted}>
            {form?.kind === "remove" ? "" : query || "Search machines (i or /)"}
          </text>
        )}
      </box>
      {form?.kind === "remove" ? (
        <>
          <text>
            Forget {form.value} ({form.id})?
          </text>
          <text fg={emberTide.textMuted}>
            The VM and its sessions will remain unchanged.
          </text>
          <text fg={emberTide.amber}>Enter remove · Esc cancel</text>
        </>
      ) : (
        <>
          <scrollbox
            ref={listRef}
            height={Math.max(
              1,
              Math.min(
                10,
                rows.length || 1,
                Math.floor(geometry.height * 0.85) - 9,
              ),
            )}
          >
            {rows.map((machine) => (
              <box
                id={`machine-row:${machine.id}`}
                key={machine.id}
                height={1}
                flexShrink={0}
                backgroundColor={
                  machine.id === selected?.id
                    ? emberTide.selection
                    : emberTide.backgroundRaised
                }
              >
                <text
                  wrapMode="none"
                  truncate
                  fg={
                    machine.id === selected?.id
                      ? emberTide.selectionText
                      : emberTide.text
                  }
                >
                  {machine.id === selected?.id ? "> " : "  "}
                  {machine.favorite ? "★ " : ""}
                  {machine.label && machine.label !== machine.id
                    ? `${machine.label} (${machine.id})`
                    : machine.id}
                  {machine.id === props.active ? " · current" : ""}
                </text>
              </box>
            ))}
            {!rows.length ? (
              <text fg={emberTide.textMuted}>No matching machines</text>
            ) : null}
          </scrollbox>
          <text fg={emberTide.textMuted}>
            {form
              ? "Enter save · Esc cancel"
              : "Enter choose · Ctrl-F favorite · Ctrl-R rename"}
          </text>
          {!form ? (
            <text fg={emberTide.textMuted}>
              j/k move · i search · a add · d remove · h handoff · Esc close
            </text>
          ) : null}
        </>
      )}
      {submitted || props.management?.pending ? (
        <text fg={emberTide.amber}>Saving…</text>
      ) : null}
      {error ? <text fg={emberTide.amber}>{error}</text> : null}
    </OverlayFrame>
  )
}

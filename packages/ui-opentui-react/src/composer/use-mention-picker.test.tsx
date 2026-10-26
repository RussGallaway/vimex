import { expect, mock, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { useRenderer } from "@opentui/react"
import { KeymapProvider } from "@opentui/keymap/react"
import { act, useMemo, useRef, useState } from "react"
import type { TextareaRenderable } from "@opentui/core"
import type { MentionCandidate } from "@vimex/conversation"
import { initialInteraction } from "@vimex/interaction"
import { createVimexKeymap } from "../keymap/create-keymap"
import { inertController, type VimexUiController } from "../contracts"
import { useMentionPicker } from "./use-mention-picker"

test("Enter attaches a directory from the @ picker", async () => {
  const directory: MentionCandidate = {
    kind: "file",
    name: "src/components/",
    path: "/work/src/components",
    detail: "Directory",
  }
  const attachMention = mock(() => {})
  const changeDraft = mock(() => {})
  const controller: VimexUiController = {
    ...inertController,
    searchMentions: async () => [directory],
    attachMention,
    changeDraft,
  }
  function Picker() {
    const textareaRef = useRef<TextareaRenderable>(null)
    const picker = useMentionPicker({
      text: "use @comp",
      textareaRef,
      controller,
      cwd: "/work",
      interaction: {
        ...initialInteraction(),
        mode: "insert",
        surface: "composer",
      },
    })
    return <text>{picker.choices.map((choice) => choice.name).join(",")}</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = useMemo(() => createVimexKeymap(renderer), [renderer])
    return (
      <KeymapProvider keymap={keymap}>
        <Picker />
      </KeymapProvider>
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 24 })
  try {
    await act(async () => setup.flush())
    await act(async () => setup.flush())
    await act(async () => {
      setup.mockInput.pressKey("RETURN")
      await setup.flush()
    })
    expect(changeDraft).toHaveBeenCalledWith("use ", 4)
    expect(attachMention).toHaveBeenCalledWith(directory, 4)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("mention picker cancels superseded and inactive searches and ignores late results", async () => {
  const requests: Array<{
    query: string
    signal: AbortSignal
    pending: ReturnType<
      typeof Promise.withResolvers<readonly MentionCandidate[]>
    >
  }> = []
  const controller: VimexUiController = {
    ...inertController,
    searchMentions(query, _kind, _cwd, signal) {
      const pending = Promise.withResolvers<readonly MentionCandidate[]>()
      requests.push({ query, signal: signal!, pending })
      return pending.promise
    },
  }
  let setText!: (text: string) => void
  let picker!: ReturnType<typeof useMentionPicker>
  function Picker() {
    const [text, updateText] = useState("@old")
    setText = updateText
    const textareaRef = useRef<TextareaRenderable>(null)
    picker = useMentionPicker({
      text,
      textareaRef,
      controller,
      cwd: "/work",
      interaction: {
        ...initialInteraction(),
        mode: "insert",
        surface: "composer",
      },
    })
    return <text>{picker.choices.map((choice) => choice.name).join(",")}</text>
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = useMemo(() => createVimexKeymap(renderer), [renderer])
    return (
      <KeymapProvider keymap={keymap}>
        <Picker />
      </KeymapProvider>
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 24 })
  const update = async (action: () => void) => {
    await act(async () => {
      action()
      await setup.flush()
    })
    await act(async () => setup.flush())
  }
  try {
    await update(() => {})
    await update(() => setText("@new"))
    expect(requests.map(({ query }) => query)).toEqual(["old", "new"])
    expect(requests[0]!.signal.aborted).toBe(true)
    const candidate: MentionCandidate = {
      kind: "file",
      name: "new",
      path: "/work/new",
    }
    await update(() => requests[1]!.pending.resolve([candidate]))
    await update(() =>
      requests[0]!.pending.resolve([{ ...candidate, name: "old" }]),
    )
    expect(picker.choices).toEqual([candidate])
    await update(() => setText("plain draft"))
    expect(requests[1]!.signal.aborted).toBe(true)
    expect(picker.choices).toEqual([])
    await update(() => setText("@last"))
    expect(requests.at(-1)!.signal.aborted).toBe(false)
  } finally {
    await act(async () => setup.renderer.destroy())
  }
  expect(requests.at(-1)!.signal.aborted).toBe(true)
})

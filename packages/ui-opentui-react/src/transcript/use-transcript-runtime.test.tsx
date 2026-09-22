import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { createConversation, threadId } from "@vimex/conversation"
import {
  initialTranscript,
  TranscriptRuntime,
  type TranscriptFrame,
  type TranscriptRuntimeInput,
} from "@vimex/transcript"
import { act, useState } from "react"
import { useTranscriptRuntime } from "./use-transcript-runtime"

function runtimeInput(name: string): TranscriptRuntimeInput {
  const id = threadId(name)
  return {
    threadId: id,
    canonicalGeneration: 0,
    canonicalRevision: 0,
    conversation: createConversation(id),
    transcript: initialTranscript(),
    mode: "follow",
  }
}

test("uses a host-owned transcript runtime without constructing a disposable fallback", async () => {
  const owned = new TranscriptRuntime(runtimeInput("owned"))
  const ignoredInput: TranscriptRuntimeInput = {
    ...runtimeInput("ignored-fallback"),
    get conversation(): never {
      throw new Error("owned runtime must short-circuit fallback projection")
    },
  }
  const dispose = spyOn(TranscriptRuntime.prototype, "dispose")
  let latest: TranscriptFrame | undefined
  function Harness() {
    latest = useTranscriptRuntime(
      { transcriptRuntime: () => owned },
      "main",
      ignoredInput,
    )
    return <text>{latest.mode}</text>
  }
  const setup = await testRender(<Harness />, { width: 20, height: 2 })
  let destroyed = false
  try {
    await act(async () => setup.flush())
    expect(latest).toBe(owned.getSnapshot())
    await act(async () => setup.renderer.destroy())
    destroyed = true
    expect(dispose).not.toHaveBeenCalled()
  } finally {
    if (!destroyed) await act(async () => setup.renderer.destroy())
    dispose.mockRestore()
    owned.dispose()
  }
})

test("uses a stateless empty frame until ownership appears without retaining a React runtime", async () => {
  const owned = new TranscriptRuntime(runtimeInput("eventual-owner"))
  const dispose = spyOn(TranscriptRuntime.prototype, "dispose")
  let current: TranscriptRuntime | undefined
  let activate!: () => void
  let latest: TranscriptFrame | undefined
  function Harness() {
    const [, rerender] = useState(0)
    activate = () => {
      current = owned
      rerender((value) => value + 1)
    }
    latest = useTranscriptRuntime(
      { transcriptRuntime: () => current },
      "main",
      runtimeInput("fallback"),
    )
    return <text>{latest.mode}</text>
  }
  const setup = await testRender(<Harness />, { width: 20, height: 2 })
  let destroyed = false
  try {
    await act(async () => setup.flush())
    expect(latest?.displayedCanonicalRevision).toBe(0)
    await act(async () => {
      activate()
      await setup.flush()
    })
    expect(latest).toBe(owned.getSnapshot())
    await act(async () => setup.renderer.destroy())
    destroyed = true
    expect(dispose).not.toHaveBeenCalled()
  } finally {
    if (!destroyed) await act(async () => setup.renderer.destroy())
    dispose.mockRestore()
    owned.dispose()
  }
})

test("suspends hidden runtime publications and reads the latest owned frame on reveal", async () => {
  const owned = new TranscriptRuntime(runtimeInput("suspended-owner"))
  const originalSubscribe = owned.subscribe
  const dispose = spyOn(TranscriptRuntime.prototype, "dispose")
  let activeSubscriptions = 0
  owned.subscribe = (listener) => {
    activeSubscriptions++
    const stop = originalSubscribe(listener)
    return () => {
      activeSubscriptions--
      stop()
    }
  }
  let setVisible!: (visible: boolean) => void
  let rerenderParent!: () => void
  let latest: TranscriptFrame | undefined
  let renders = 0
  function Harness() {
    const [visible, updateVisible] = useState(true)
    const [, updateParent] = useState(0)
    setVisible = updateVisible
    rerenderParent = () => updateParent((value) => value + 1)
    latest = useTranscriptRuntime(
      { transcriptRuntime: () => owned },
      "main",
      runtimeInput("ignored"),
      visible,
    )
    renders++
    return <text>{latest.presentationRevision}</text>
  }
  const setup = await testRender(<Harness />, { width: 20, height: 2 })
  let destroyed = false
  try {
    await act(async () => setup.flush())
    expect(activeSubscriptions).toBe(1)
    await act(async () => {
      setVisible(false)
      await setup.flush()
    })
    expect(activeSubscriptions).toBe(0)
    const hiddenRenders = renders
    const newest = owned.resetLayout("width")
    await act(async () => setup.flush())
    expect(renders).toBe(hiddenRenders)
    expect(latest).not.toBe(newest)
    await act(async () => {
      rerenderParent()
      await setup.flush()
    })
    expect(renders).toBe(hiddenRenders + 1)
    expect(latest).not.toBe(newest)

    await act(async () => {
      setVisible(true)
      await setup.flush()
    })
    expect(activeSubscriptions).toBe(1)
    expect(latest).toBe(newest)
    await act(async () => setup.renderer.destroy())
    destroyed = true
    expect(activeSubscriptions).toBe(0)
    expect(dispose).not.toHaveBeenCalled()
  } finally {
    if (!destroyed) await act(async () => setup.renderer.destroy())
    dispose.mockRestore()
    owned.dispose()
  }
})

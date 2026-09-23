import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState } from "react"
import { threadId, turnId } from "@vimex/conversation"
import {
  activeWorkspace,
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchCommand,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function queueHarness(
  count: number,
  draft = "",
  insert = false,
  size = { width: 80, height: 24 },
) {
  const id = threadId("queue-dock")
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id,
      title: "Queue dock",
      cwd: "/tmp",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = transitionWorkbench(initial, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: id, turnId: turnId("running") },
  }).state
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface: "composer" },
  }).state
  for (let index = 1; index <= count; index++) {
    initial = transitionWorkbench(initial, {
      type: "composer.change",
      text: `queued message ${index}`,
    }).state
    initial = transitionWorkbench(initial, {
      type: "composer.submit",
      intent: "next-turn",
      clientMessageId: `queued-${index}`,
    }).state
  }
  if (draft)
    initial = transitionWorkbench(initial, {
      type: "composer.change",
      text: draft,
    }).state
  if (insert)
    initial = transitionWorkbench(initial, {
      type: "interaction.command",
      command: { type: "mode.insert" },
    }).state
  let observed = initial
  let submitted = 0
  let interrupted = 0
  let update!: (command: WorkbenchCommand) => void
  function Harness() {
    const [state, setState] = useState<WorkbenchState>(initial)
    update = (command) => {
      observed = transitionWorkbench(observed, command).state
      setState(observed)
    }
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        dispatchInteraction(command) {
          update({ type: "interaction.command", command })
        },
        changeDraft(text, cursorOffset) {
          update({ type: "composer.change", text, cursorOffset })
        },
        unqueueOutgoing(messageId) {
          update({ type: "composer.unqueue", clientMessageId: messageId })
          return !activeWorkspace(observed)?.composer.outbox.some(
            (message) => message.id === messageId,
          )
        },
        removeQueuedOutgoing(messageId) {
          update({ type: "composer.removeQueued", clientMessageId: messageId })
          return !activeWorkspace(observed)?.composer.outbox.some(
            (message) => message.id === messageId,
          )
        },
        submit(intent) {
          update({
            type: "composer.submit",
            intent,
            clientMessageId: `sent-${++submitted}`,
          })
          return true
        },
        interrupt() {
          interrupted++
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<Harness />, size)
  await act(async () => setup.flush())
  const key = async (name: string) => {
    await act(async () => {
      if (name === "ctrl-k") setup.mockInput.pressKey("k", { ctrl: true })
      else if (name === "ctrl-j") setup.mockInput.pressKey("j", { ctrl: true })
      else if (name === "ctrl-c") setup.mockInput.pressKey("c", { ctrl: true })
      else if (name === "return") setup.mockInput.pressKey("RETURN")
      else await setup.mockInput.typeText(name)
      await setup.flush()
      await setup.renderOnce()
    })
  }
  return { ...setup, key, state: () => observed, interrupts: () => interrupted }
}

test("Enter queues a visible preview and Ctrl-K opens it from Insert mode", async () => {
  const h = await queueHarness(0, "", true)
  try {
    await h.key("new follow-up")
    await h.key("return")
    expect(h.captureCharFrame()).toContain("latest: new follow-up")
    expect(activeWorkspace(h.state())?.composer.outbox).toMatchObject([
      { text: "new follow-up", status: "queued" },
    ])
    await h.key("ctrl-k")
    expect(h.captureCharFrame()).toContain(">1. new follow-up")
    expect(activeWorkspace(h.state())?.interaction.mode).toBe("normal")
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("queue previews the latest message and Ctrl-K/J traverse queued rows", async () => {
  const h = await queueHarness(5)
  try {
    expect(h.captureCharFrame()).toContain("5 queued")
    expect(h.captureCharFrame()).toContain("latest: queued message 5")
    await h.key("ctrl-k")
    expect(h.captureCharFrame()).toContain("QUEUE · 5 total")
    expect(h.captureCharFrame()).toContain(">5. queued message 5")
    await h.key("ctrl-k")
    expect(h.captureCharFrame()).toContain(">4. queued message 4")
    await h.key("ctrl-j")
    expect(h.captureCharFrame()).toContain(">5. queued message 5")
    for (let index = 0; index < 5; index++) await h.key("ctrl-k")
    expect(activeWorkspace(h.state())?.interaction.surface).toBe("transcript")
    expect(h.captureCharFrame()).toContain("5 queued")
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("queue e restores an empty draft; x confirms removal", async () => {
  const h = await queueHarness(2)
  try {
    await h.key("ctrl-k")
    await h.key("x")
    expect(h.captureCharFrame()).toContain("Remove this queued message?")
    await h.key("n")
    expect(activeWorkspace(h.state())?.composer.outbox).toHaveLength(2)
    await h.key("x")
    await h.key("y")
    expect(
      activeWorkspace(h.state())?.composer.outbox.map((item) => item.id),
    ).toEqual(["queued-1"])
    await h.key("e")
    expect(activeWorkspace(h.state())?.composer).toMatchObject({
      text: "queued message 1",
      outbox: [],
    })
    expect(activeWorkspace(h.state())?.interaction).toMatchObject({
      mode: "insert",
      surface: "composer",
    })
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("queue e preserves a nonempty composer draft", async () => {
  const h = await queueHarness(1, "different draft")
  try {
    await h.key("ctrl-k")
    await h.key("e")
    expect(h.captureCharFrame()).toContain("Finish or clear the current draft")
    expect(activeWorkspace(h.state())?.composer).toMatchObject({
      text: "different draft",
      outbox: [{ id: "queued-1", status: "queued" }],
    })
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("remove confirmation keeps Ctrl-C interrupt available", async () => {
  const h = await queueHarness(1)
  try {
    await h.key("ctrl-k")
    await h.key("x")
    await h.key("ctrl-c")
    expect(h.interrupts()).toBe(1)
    expect(activeWorkspace(h.state())?.composer.outbox).toHaveLength(1)
    expect(h.captureCharFrame()).not.toContain("Remove this queued message?")
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

test("narrow and short terminals keep the queue preview and transcript visible", async () => {
  const narrow = await queueHarness(2, "", false, { width: 30, height: 24 })
  try {
    expect(narrow.captureCharFrame()).toContain("2 queued")
    expect(narrow.captureCharFrame()).toContain("queued message 2")
  } finally {
    await act(async () => narrow.renderer.destroy())
  }
  const short = await queueHarness(5, "", false, { width: 48, height: 12 })
  try {
    await short.key("ctrl-k")
    expect(short.captureCharFrame()).toContain(">5. queued message 5")
    expect(
      short.renderer.root.findDescendantById("transcript")!.height,
    ).toBeGreaterThan(0)
    expect(short.captureCharFrame()).toContain("NORMAL")
  } finally {
    await act(async () => short.renderer.destroy())
  }
})

test("expanded composer leaves transcript room when the queue opens", async () => {
  const draft = Array.from({ length: 30 }, (_, index) => `draft ${index}`).join(
    "\n",
  )
  const h = await queueHarness(5, draft)
  try {
    await h.key(" e")
    await h.key("ctrl-k")
    expect(h.captureCharFrame()).toContain("QUEUE · 5 total")
    expect(
      h.renderer.root.findDescendantById("transcript")!.height,
    ).toBeGreaterThan(0)
    expect(h.captureCharFrame()).toContain("NORMAL")
  } finally {
    await act(async () => h.renderer.destroy())
  }
})

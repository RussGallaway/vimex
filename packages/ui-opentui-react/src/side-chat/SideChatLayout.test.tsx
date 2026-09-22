import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import {
  itemId,
  threadId,
  turnId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  VimexController,
  type RuntimeConnection,
  type WorkbenchCommand,
  type WorkbenchPublicationHost,
  type WorkbenchState,
} from "@vimex/workbench"
import { ConnectedVimexRoot, VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"
import { useVisiblePresentationSnapshot } from "./SideChatLayout"

const parent = threadId("parent"),
  child = threadId("side")
async function harness(width = 140, height = 36, initiallyOpen = true) {
  let initial = initialWorkbench()
  for (const id of [parent, child]) {
    initial = transitionWorkbench(initial, {
      type: "thread.open",
      summary: {
        id,
        title: id === parent ? "Parent task" : "Side questions",
        cwd: "/tmp",
        model: "test",
        reasoningEffort: "medium",
        status: "working",
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "conversation.event",
      event: {
        type: "turn.started",
        threadId: id,
        turnId: turnId(`${id}-turn`),
        startedAt: Date.now() - 2_000,
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: id,
        item: {
          id: itemId(`${id}-answer`),
          turnId: turnId(`${id}-turn`),
          kind: "assistant",
          markdown:
            `${id} unique answer\n\n` +
            Array.from({ length: 35 }, (_, n) => `${id} line ${n}`).join(
              "\n\n",
            ),
          status: "running",
        },
      },
    }).state
    initial = transitionWorkbench(initial, {
      type: "composer.change",
      text: `${id} draft`,
      cursorOffset: 2,
    }).state
    initial = transitionWorkbench(initial, {
      type: "interaction.command",
      command: { type: "focus.set", surface: "composer" },
    }).state
  }
  initial = transitionWorkbench(initial, {
    type: "connection.changed",
    connection: "connected",
  }).state
  initial = {
    ...initial,
    sideChats: {
      [parent]: {
        parentId: parent,
        threadId: child,
        visible: true,
        maximized: false,
        contextLabel: "Parent snapshot",
      },
    },
  }
  if (!initiallyOpen)
    initial = { ...initial, activeThreadId: parent, sideChats: {} }
  let beginOpening!: () => void
  let associate!: (open: boolean) => void
  let observed = initial
  let update!: (command: WorkbenchCommand) => void
  const actions: string[] = []
  function Harness() {
    const [state, setState] = useState(initial)
    beginOpening = () =>
      setState((current) => ({
        ...current,
        activeThreadId: parent,
        sideChats: {
          [parent]: {
            parentId: parent,
            visible: true,
            maximized: false,
            status: "creating",
          },
        },
      }))
    associate = (open) =>
      setState((current) => ({
        ...current,
        activeThreadId: open ? child : parent,
        sideChats: open
          ? {
              [parent]: {
                parentId: parent,
                threadId: child,
                visible: true,
                maximized: false,
              },
            }
          : {},
      }))
    observed = state
    update = (command) =>
      setState((current) => transitionWorkbench(current, command).state)
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        dispatchInteraction(command) {
          update({ type: "interaction.command", command })
        },
        changeDraft(text, cursorOffset) {
          update({ type: "composer.change", text, cursorOffset })
        },
        anchorThread(threadId, point, preferredScreenRow) {
          update({
            type: "transcript.command",
            threadId,
            command: { type: "viewport.anchor", point, preferredScreenRow },
          })
        },
        sideChat(action) {
          actions.push(action)
          setState((current) => {
            const side = current.sideChats[parent]!
            if (action === "parent" || action === "side" || action === "cycle")
              return {
                ...current,
                activeThreadId:
                  action === "parent" ||
                  (action === "cycle" && current.activeThreadId === child)
                    ? parent
                    : child,
              }
            if (action === "close")
              return {
                ...current,
                activeThreadId: parent,
                sideChats: { [parent]: { ...side, visible: false } },
              }
            return {
              ...current,
              sideChats: {
                [parent]: {
                  ...side,
                  maximized: action === "maximize" ? !side.maximized : false,
                },
              },
            }
          })
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<Harness />, { width, height })
  const settle = async () =>
    act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  await settle()
  const key = async (name: string, ctrl = false) =>
    act(async () => {
      setup.mockInput.pressKey(name, { ctrl })
      if (name === "ESCAPE") await Bun.sleep(30)
      await setup.flush()
      await setup.renderOnce()
    })
  const windowKey = async (name: string) => {
    await key("w", true)
    await key(name)
    await settle()
  }
  return {
    ...setup,
    settle,
    key,
    windowKey,
    actions,
    state: () => observed,
    update,
    beginOpening: () => beginOpening(),
    associate: (open: boolean) => associate(open),
    close: () => act(async () => setup.renderer.destroy()),
  }
}

test("side split shows both transcripts, routes input to focused composer, and maximizes/restores", async () => {
  const h = await harness()
  try {
    expect(h.captureCharFrame()).toContain("SIDE · focused")
    const main = h.renderer.root.findDescendantById("main-pane")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(main.x).toBe(0)
    expect(side.x).toBeGreaterThan(main.width)
    expect(main.findDescendantById("transcript")).toBeDefined()
    expect(side.findDescendantById("transcript")).toBeDefined()
    await h.key("i")
    await act(async () => {
      await h.mockInput.typeText("X")
      await h.flush()
    })
    expect(h.state().workspaces[child]!.composer.text).toContain("X")
    expect(h.state().workspaces[parent]!.composer.text).toBe("parent draft")
    // Real terminal Backspace uses DEL; the mock BACKSPACE key emits BS (Ctrl-H).
    await act(async () => {
      await h.mockInput.typeText("\x7f")
      await h.flush()
    })
    expect(h.state().activeThreadId).toBe(child)
    expect(h.state().workspaces[child]!.composer.text).not.toContain("X")
    await act(async () => {
      await h.mockInput.typeText("X")
      await h.flush()
    })
    await h.key("h", true)
    expect(h.state().activeThreadId).toBe(parent)
    await h.key("l", true)
    expect(h.state().activeThreadId).toBe(child)
    await h.windowKey("|")
    expect(h.renderer.root.findDescendantById("main-pane")!.visible).toBe(false)
    expect(h.renderer.root.findDescendantById("side-pane")!.width).toBe(140)
    await h.windowKey("=")
    expect(h.renderer.root.findDescendantById("main-pane")).toBeDefined()
    await h.windowKey("w")
    expect(h.state().activeThreadId).toBe(parent)
    await h.windowKey("c")
    expect(
      h.renderer.root.findDescendantById("side-chat-layout"),
    ).toBeUndefined()
    expect(h.state().workspaces[child]!.composer.text).toContain("X")
  } finally {
    await h.close()
  }
})

test("narrow side layout stacks panes and rename leader hints focused title", async () => {
  const h = await harness(80, 32)
  try {
    const main = h.renderer.root.findDescendantById("main-pane")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(side.y).toBeGreaterThan(main.y + main.height)
    expect(side.width).toBe(80)
    expect(
      h.renderer.root.findDescendantById("inactive-composer"),
    ).toBeUndefined()
    await act(async () => {
      await h.mockInput.typeText(" r")
      await h.flush()
      await h.renderOnce()
    })
    expect(h.state().workspaces[child]!.interaction.commandLine).toBe("rename ")
    expect(h.captureCharFrame()).toContain("Current name: Side questions")
    expect(h.state().workspaces[parent]!.interaction.mode).toBe("normal")
  } finally {
    await h.close()
  }
})

test("Flash labels use side-local coordinates and jumping preserves the other pane", async () => {
  const h = await harness()
  try {
    await h.key("s")
    await act(async () => {
      await h.mockInput.typeText("line 34")
      await h.flush()
      await h.renderOnce()
    })
    const label = h.renderer.root.findDescendantById("flash-label:a")!
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(label).toBeDefined()
    expect(label.screenX).toBeGreaterThan(side.screenX)
    expect(label.screenX).toBeLessThan(side.screenX + side.width)
    await h.key("RETURN")
    expect(h.state().workspaces[parent]!.composer.text).toBe("parent draft")
  } finally {
    await h.close()
  }
})

test("hiding a pane releases native transcript selection but preserves semantic selection", async () => {
  const h = await harness()
  try {
    await h.windowKey("h")
    await act(async () => {
      h.update({
        type: "interaction.command",
        threadId: parent,
        command: { type: "focus.set", surface: "transcript" },
      })
      h.update({
        type: "transcript.command",
        threadId: parent,
        command: {
          type: "cursor.move",
          point: { itemId: itemId("parent-answer"), graphemeOffset: 0 },
          preferredScreenRow: 2,
        },
      })
      h.update({
        type: "transcript.command",
        threadId: parent,
        command: { type: "selection.begin", shape: "character" },
      })
      h.update({
        type: "transcript.command",
        threadId: parent,
        command: {
          type: "cursor.move",
          point: { itemId: itemId("parent-answer"), graphemeOffset: 5 },
          preferredScreenRow: 2,
        },
      })
      h.update({
        type: "interaction.command",
        threadId: parent,
        command: { type: "mode.visual" },
      })
      await h.flush()
      await h.renderOnce()
    })
    await h.settle()
    expect(h.renderer.getSelection()).not.toBeNull()
    const semantic = h.state().workspaces[parent]!.transcript.selection
    expect(semantic).toBeDefined()

    await h.windowKey("l")
    await h.windowKey("|")
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("transcript"),
    ).toBeUndefined()
    expect(h.renderer.getSelection()).toBeNull()
    expect(h.state().workspaces[parent]!.transcript.selection).toEqual(semantic)

    await h.windowKey("h")
    await h.settle()
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("transcript"),
    ).toBeDefined()
    expect(h.state().workspaces[parent]!.transcript.selection).toEqual(semantic)
    expect(h.renderer.getSelection()).not.toBeNull()
  } finally {
    await h.close()
  }
})

test("pane focus retains composer Visual selection and Ex history", async () => {
  const h = await harness()
  try {
    await h.key("v")
    await h.key("l")
    const side = h.renderer.root.findDescendantById("side-pane")!
    const composer = side.findDescendantById("composer") as TextareaRenderable
    const selection = composer.getSelection()
    expect(selection).not.toBeNull()
    await h.windowKey("h")
    await h.windowKey("l")
    expect(side.findDescendantById("composer")).toBe(composer)
    expect(composer.getSelection()).toEqual(selection)
    await h.key("ESCAPE")
    await act(async () => {
      await h.mockInput.typeText(":rename Side renamed")
      await h.flush()
    })
    await h.key("RETURN")
    await h.windowKey("h")
    await h.windowKey("l")
    await h.key(":")
    await h.key("p", true)
    expect(h.state().workspaces[child]!.interaction.commandLine).toBe(
      "rename Side renamed",
    )
  } finally {
    await h.close()
  }
})

test("short terminals maximize active pane while retaining live parent status", async () => {
  const h = await harness(80, 16)
  try {
    const hiddenMain = h.renderer.root.findDescendantById("main-pane")!
    expect(hiddenMain.visible).toBe(false)
    expect(hiddenMain.findDescendantById("transcript")).toBeUndefined()
    const parentComposer = hiddenMain.findDescendantById("composer")
    expect(parentComposer).toBeDefined()
    const side = h.renderer.root.findDescendantById("side-pane")!
    expect(side.visible).toBe(true)
    expect(side.findDescendantById("transcript")!.height).toBeGreaterThan(0)
    expect(h.captureCharFrame()).toContain("Main:")
    await h.windowKey("h")
    const visibleMain = h.renderer.root.findDescendantById("main-pane")!
    const hiddenSide = h.renderer.root.findDescendantById("side-pane")!
    expect(visibleMain.visible).toBe(true)
    expect(visibleMain.findDescendantById("transcript")).toBeDefined()
    expect(visibleMain.findDescendantById("composer")).toBe(parentComposer)
    expect(hiddenSide.visible).toBe(false)
    expect(hiddenSide.findDescendantById("transcript")).toBeUndefined()
    expect(hiddenSide.findDescendantById("composer")).toBeDefined()

    await h.key("v")
    await h.key("l")
    const composer = visibleMain.findDescendantById(
      "composer",
    ) as TextareaRenderable
    const selection = composer.getSelection()
    expect(selection).not.toBeNull()
    await h.windowKey("l")
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("transcript"),
    ).toBeUndefined()
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("composer"),
    ).toBe(composer)
    expect(composer.getSelection()).toEqual(selection)
    await h.windowKey("h")
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("composer"),
    ).toBe(composer)
    expect(composer.getSelection()).toEqual(selection)
  } finally {
    await h.close()
  }
})

test("a hidden connected presentation retains its snapshot and refreshes directly on reveal", async () => {
  let snapshot: WorkbenchState = { ...initialWorkbench(), error: "visible" }
  const listeners = new Set<() => void>()
  let activeSubscriptions = 0
  const host: WorkbenchPublicationHost = {
    getLayoutSnapshot: () => {
      throw new Error("layout is outside this focused bridge test")
    },
    subscribeLayout: () => () => {},
    getPresentationSnapshot: () => snapshot,
    subscribePresentation: (_presentationId, listener) => {
      activeSubscriptions++
      listeners.add(listener)
      return () => {
        activeSubscriptions--
        listeners.delete(listener)
      }
    },
  }
  let setVisible!: (visible: boolean) => void
  let rerenderParent!: () => void
  let observed: WorkbenchState | undefined
  function Harness() {
    const [visible, updateVisible] = useState(true)
    const [, updateParent] = useState(0)
    setVisible = updateVisible
    rerenderParent = () => updateParent((value) => value + 1)
    observed = useVisiblePresentationSnapshot(host, "main", visible)
    return <text>{observed.error}</text>
  }
  const setup = await testRender(<Harness />, { width: 20, height: 2 })
  try {
    await act(async () => setup.flush())
    expect(activeSubscriptions).toBe(1)
    expect(observed?.error).toBe("visible")
    await act(async () => {
      setVisible(false)
      await setup.flush()
    })
    expect(activeSubscriptions).toBe(0)
    snapshot = { ...snapshot, error: "hidden update" }
    await act(async () => {
      rerenderParent()
      await setup.flush()
    })
    expect(observed?.error).toBe("visible")

    await act(async () => {
      setVisible(true)
      await setup.flush()
    })
    expect(activeSubscriptions).toBe(1)
    expect(observed?.error).toBe("hidden update")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
  expect(activeSubscriptions).toBe(0)
})

test("connected maximize and close suspend both pane publications and runtime subscriptions", async () => {
  const summary = (id: typeof parent): ThreadSummary => ({
    id,
    title: id,
    cwd: "/tmp",
    model: "test",
    reasoningEffort: "medium",
    status: "idle",
  })
  const backend: ConversationGateway & RuntimeConnection = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: () => () => {},
    listThreads: async () => [summary(parent)],
    startThread: async () => ({ summary: summary(parent), events: [] }),
    resumeThread: async (id) => ({ summary: summary(id), events: [] }),
    forkThread: async () => ({ summary: summary(child), events: [] }),
    forkSideThread: async () => ({ summary: summary(child), events: [] }),
    retireThread: async () => {},
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    renameThread: async () => {},
    updateSettings: async () => {},
  }
  const controller = new VimexController({
    conversation: backend,
    connection: backend,
    approvals: { resolveApproval: async () => {} },
    models: { listModels: async () => [] },
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit: () => {},
  })
  await controller.initialize("/tmp")
  controller.sideChat("open")
  await controller.settle()
  const mainRuntime = controller.transcriptRuntime("main")!
  const sideRuntime = controller.transcriptRuntime("side")!
  const runtimeSubscriptions = { main: 0, side: 0 }
  for (const [id, runtime] of [
    ["main", mainRuntime],
    ["side", sideRuntime],
  ] as const) {
    const original = runtime.subscribe
    runtime.subscribe = (listener) => {
      runtimeSubscriptions[id]++
      const stop = original(listener)
      return () => {
        runtimeSubscriptions[id]--
        stop()
      }
    }
  }
  const presentationSubscriptions = { main: 0, side: 0 }
  const originalPresentationSubscribe = controller.subscribePresentation
  controller.subscribePresentation = (id, listener) => {
    presentationSubscriptions[id]++
    const stop = originalPresentationSubscribe(id, listener)
    return () => {
      presentationSubscriptions[id]--
      stop()
    }
  }
  const setup = await testRender(
    <ConnectedVimexRoot controller={controller} />,
    { width: 140, height: 36 },
  )
  const settle = async () =>
    act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  const update = async (operation: () => void) =>
    act(async () => {
      operation()
      await setup.flush()
      await setup.renderOnce()
    })
  try {
    await settle()
    expect(presentationSubscriptions).toEqual({ main: 1, side: 1 })
    expect(runtimeSubscriptions).toEqual({ main: 1, side: 1 })
    const mainPane = setup.renderer.root.findDescendantById("main-pane")!
    const mainComposer = mainPane.findDescendantById("composer")

    await update(() => controller.sideChat("maximize"))
    expect(presentationSubscriptions).toEqual({ main: 0, side: 1 })
    expect(runtimeSubscriptions).toEqual({ main: 0, side: 1 })
    expect(mainPane.findDescendantById("transcript")).toBeUndefined()
    expect(mainPane.findDescendantById("composer")).toBe(mainComposer)
    expect(controller.transcriptRuntime("main")).toBe(mainRuntime)

    await update(() => {
      mainRuntime.resetLayout("width")
    })
    expect(runtimeSubscriptions.main).toBe(0)
    await update(() => controller.sideChat("parent"))
    expect(presentationSubscriptions).toEqual({ main: 1, side: 0 })
    expect(runtimeSubscriptions).toEqual({ main: 1, side: 0 })
    expect(mainPane.findDescendantById("transcript")).toBeDefined()
    expect(controller.transcriptRuntime("main")!.getSnapshot()).toBe(
      mainRuntime.getSnapshot(),
    )

    await update(() => controller.sideChat("reset"))
    expect(presentationSubscriptions).toEqual({ main: 1, side: 1 })
    expect(runtimeSubscriptions).toEqual({ main: 1, side: 1 })
    const sideComposer = setup.renderer.root
      .findDescendantById("side-pane")!
      .findDescendantById("composer")
    await update(() => controller.sideChat("close"))
    const retainedSide = setup.renderer.root.findDescendantById("side-pane")!
    expect(presentationSubscriptions).toEqual({ main: 1, side: 0 })
    expect(runtimeSubscriptions).toEqual({ main: 1, side: 0 })
    expect(retainedSide.findDescendantById("transcript")).toBeUndefined()
    expect(retainedSide.findDescendantById("composer")).toBe(sideComposer)
    expect(controller.transcriptRuntime("side")).toBe(sideRuntime)
  } finally {
    await act(async () => setup.renderer.destroy())
    await controller.close()
  }
  expect(presentationSubscriptions).toEqual({ main: 0, side: 0 })
  expect(runtimeSubscriptions).toEqual({ main: 0, side: 0 })
})

test("a maximized layout schedules no heartbeat for its mounted hidden pane", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  const h = await harness(80, 16)
  try {
    const heartbeatCalls = intervals.mock.calls
      .map((args, index) => ({
        args,
        timer: intervals.mock.results[index]?.value,
      }))
      .filter((call) => call.args[1] === 120)
    expect(heartbeatCalls).toHaveLength(1)
    const firstTimer = heartbeatCalls[0]!.timer
    await h.windowKey("h")
    expect(intervals.mock.calls.filter((args) => args[1] === 120)).toHaveLength(
      2,
    )
    expect(cleared.mock.calls.some((args) => args[0] === firstTimer)).toBe(true)
  } finally {
    await h.close()
    intervals.mockRestore()
    cleared.mockRestore()
  }
})

test("a closed retained side releases its heartbeat and reacquires it when reopened", async () => {
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  const h = await harness()
  try {
    const initial = intervals.mock.calls
      .map((args, index) => ({
        args,
        timer: intervals.mock.results[index]?.value,
      }))
      .filter((call) => call.args[1] === 120)
    expect(initial).toHaveLength(2)
    await h.windowKey("c")
    expect(
      initial.some((call) =>
        cleared.mock.calls.some((args) => args[0] === call.timer),
      ),
    ).toBe(true)
    const afterClose = intervals.mock.calls.filter(
      (args) => args[1] === 120,
    ).length
    await act(async () => {
      h.associate(true)
      await h.flush()
      await h.renderOnce()
    })
    expect(intervals.mock.calls.filter((args) => args[1] === 120)).toHaveLength(
      afterClose + 1,
    )
  } finally {
    await h.close()
    intervals.mockRestore()
    cleared.mockRestore()
  }
})

test("mouse wheel in unfocused parent preserves side draft and updates only parent anchor", async () => {
  const h = await harness()
  try {
    const main = h.renderer.root.findDescendantById("main-pane")!
    const scroll = main.findDescendantById("transcript") as ScrollBoxRenderable
    const sideViewport = h.state().workspaces[child]!.transcript.viewport
    await act(async () => {
      await h.mockMouse.scroll(scroll.screenX + 8, scroll.screenY + 3, "up")
      await h.flush()
      await h.renderOnce()
    })
    await h.settle()
    expect(h.state().activeThreadId).toBe(child)
    expect(h.state().workspaces[parent]!.transcript.viewport.kind).toBe("point")
    expect(h.state().workspaces[child]!.transcript.viewport).toEqual(
      sideViewport,
    )
    expect(h.state().workspaces[child]!.composer.text).toBe("side draft")
  } finally {
    await h.close()
  }
})

test("first side open and retirement preserve the mounted parent composer", async () => {
  const h = await harness(140, 36, false)
  try {
    const composer = h.renderer.root
      .findDescendantById("main-pane")!
      .findDescendantById("composer") as TextareaRenderable
    await h.key("v")
    await h.key("l")
    const selection = composer.getSelectedText()
    expect(selection.length).toBeGreaterThan(0)
    await act(async () => {
      h.associate(true)
      await h.flush()
      await h.renderOnce()
    })
    await h.settle()
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("composer") === composer,
    ).toBe(true)
    await act(async () => {
      h.associate(false)
      await h.flush()
      await h.renderOnce()
    })
    await h.settle()
    expect(
      h.renderer.root
        .findDescendantById("main-pane")!
        .findDescendantById("composer") === composer,
    ).toBe(true)
    expect(composer.getSelectedText()).toBe(selection)
    expect(h.state().workspaces[parent]!.interaction.mode).toBe("visual")
    expect(h.captureCharFrame()).not.toContain("SIDE ·")
  } finally {
    await h.close()
  }
})

test("pending side creation immediately shows a right placeholder without stealing parent input", async () => {
  const h = await harness(140, 36, false)
  try {
    const composer = h.renderer.root
      .findDescendantById("main-pane")!
      .findDescendantById("composer")
    await act(async () => {
      h.beginOpening()
      await h.flush()
    })
    await h.settle()
    const main = h.renderer.root.findDescendantById("main-pane")!
    const opening = h.renderer.root.findDescendantById("side-opening")!
    expect(Boolean(opening)).toBe(true)
    expect(opening.screenX).toBeGreaterThan(main.screenX + main.width)
    expect(main.findDescendantById("composer") === composer).toBe(true)
    expect(h.captureCharFrame()).toContain("Opening side chat…")
    await h.key("i")
    await act(async () => {
      await h.mockInput.typeText("X")
      await h.flush()
    })
    expect(h.state().activeThreadId).toBe(parent)
    expect(h.state().workspaces[parent]!.composer.text).toContain("X")
    expect(h.state().workspaces[child]!.composer.text).toBe("side draft")
    await act(async () => {
      h.associate(true)
      await h.flush()
    })
    await h.settle()
    expect(h.renderer.root.findDescendantById("side-opening")).toBeUndefined()
    expect(h.renderer.root.findDescendantById("side-pane")!.visible).toBe(true)
  } finally {
    await h.close()
  }
})

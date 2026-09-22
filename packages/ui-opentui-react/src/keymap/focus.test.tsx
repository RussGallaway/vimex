import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TextareaRenderable } from "@opentui/core"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import { initialWorkbench, transitionWorkbench } from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

function fixture() {
  return transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: threadId("keys"),
      title: "Keys",
      cwd: "/tmp",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
}

test("Space leader opens questions without inserting into the composer", async () => {
  const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] = []
  const setup = await testRender(
    <VimexRoot
      state={fixture()}
      controller={{
        ...inertController,
        dispatchInteraction: (command) => {
          commands.push(command)
        },
      }}
    />,
    { width: 80, height: 24 },
  )
  try {
    await act(async () => setup.flush())
    await setup.mockInput.typeText(" q")
    await act(async () => setup.flush())
    expect(commands).toContainEqual({
      type: "overlay.open",
      overlay: "questions",
    })
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("Ctrl-w k works while typing and preserves the draft", async () => {
  let state = fixture()
  state = transitionWorkbench(state, {
    type: "interaction.command",
    command: { type: "mode.insert" },
  }).state
  state = transitionWorkbench(state, {
    type: "composer.change",
    text: "draft survives",
    cursorOffset: 14,
  }).state
  const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] = []
  const setup = await testRender(
    <VimexRoot
      state={state}
      controller={{
        ...inertController,
        dispatchInteraction: (command) => {
          commands.push(command)
        },
      }}
    />,
    { width: 80, height: 24 },
  )
  try {
    await act(async () => setup.flush())
    setup.mockInput.pressKey("w", { ctrl: true })
    await setup.mockInput.typeText("k")
    await act(async () => setup.flush())
    expect(commands).toContainEqual({
      type: "focus.set",
      surface: "transcript",
    })
    expect(setup.captureCharFrame()).toContain("draft survives")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("Ctrl-w clears composer Visual selection before the next Normal edit", async () => {
  let initial = fixture()
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface: "composer" },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    text: "abcd",
    cursorOffset: 1,
  }).state
  let observed = initial
  function StatefulFixture() {
    const [state, setState] = useState(initial)
    observed = state
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        dispatchInteraction(command) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "interaction.command",
                command,
              }).state,
          )
        },
        changeDraft(text, cursorOffset) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "composer.change",
                text,
                cursorOffset,
              }).state,
          )
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<StatefulFixture />, { width: 80, height: 24 })
  try {
    await act(async () => setup.flush())
    await act(async () => {
      await setup.mockInput.typeText("v")
      await setup.mockInput.typeText("l")
      await Bun.sleep(0)
      await setup.flush()
    })
    const composer = setup.renderer.root.findDescendantById(
      "composer",
    ) as TextareaRenderable
    expect(composer.getSelection()).not.toBeNull()

    await act(async () => {
      setup.mockInput.pressKey("w", { ctrl: true })
      await setup.mockInput.typeText("k")
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(observed.workspaces[threadId("keys")]?.interaction).toMatchObject({
      mode: "normal",
      surface: "transcript",
    })
    expect(composer.getSelection()).toBeNull()

    await act(async () => {
      setup.mockInput.pressKey("w", { ctrl: true })
      await setup.mockInput.typeText("j")
      await Bun.sleep(0)
      await setup.flush()
    })
    await act(async () => {
      await setup.mockInput.typeText("x")
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(observed.workspaces[threadId("keys")]?.composer.text).toBe("abd")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("leaving composer Visual through Command mode clears its native selection", async () => {
  let initial = fixture()
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface: "composer" },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    text: "abcd",
    cursorOffset: 1,
  }).state
  let observed = initial
  function StatefulFixture() {
    const [state, setState] = useState(initial)
    observed = state
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        dispatchInteraction(command) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "interaction.command",
                command,
              }).state,
          )
        },
        changeDraft(text, cursorOffset) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "composer.change",
                text,
                cursorOffset,
              }).state,
          )
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<StatefulFixture />, { width: 80, height: 24 })
  try {
    await act(async () => setup.flush())
    await act(async () => {
      await setup.mockInput.typeText("vl:")
      await Bun.sleep(0)
      await setup.flush()
    })
    const composer = setup.renderer.root.findDescendantById(
      "composer",
    ) as TextareaRenderable
    expect(observed.workspaces[threadId("keys")]?.interaction.mode).toBe(
      "command",
    )
    expect(composer.getSelection()).toBeNull()

    await act(async () => {
      setup.mockInput.pressKey("w", { ctrl: true })
      await setup.mockInput.typeText("j")
      await Bun.sleep(0)
      await setup.flush()
    })
    await act(async () => {
      await setup.mockInput.typeText("x")
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(observed.workspaces[threadId("keys")]?.composer.text).toBe("abd")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("switching threads clears a composer selection even when the target restores Visual mode", async () => {
  const source = threadId("keys")
  const target = threadId("other")
  let initial = fixture()
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "focus.set", surface: "composer" },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    text: "abcd",
    cursorOffset: 1,
  }).state
  initial = transitionWorkbench(initial, {
    type: "thread.register",
    summary: {
      id: target,
      title: "Other",
      cwd: "/tmp",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = transitionWorkbench(initial, {
    type: "composer.change",
    threadId: target,
    text: "WXYZ",
    cursorOffset: 1,
  }).state
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    threadId: target,
    command: { type: "focus.set", surface: "composer" },
  }).state
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    threadId: target,
    command: { type: "mode.visual" },
  }).state
  let observed = initial
  let switchThread!: () => void
  const copies: string[] = []
  function StatefulFixture() {
    const [state, setState] = useState(initial)
    observed = state
    switchThread = () =>
      setState(
        (current) =>
          transitionWorkbench(current, {
            type: "thread.switch",
            threadId: target,
          }).state,
      )
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        dispatchInteraction(command) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "interaction.command",
                command,
              }).state,
          )
        },
        changeDraft(text, cursorOffset) {
          setState(
            (current) =>
              transitionWorkbench(current, {
                type: "composer.change",
                text,
                cursorOffset,
              }).state,
          )
        },
        copyText(text) {
          copies.push(text)
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  const setup = await testRender(<StatefulFixture />, { width: 80, height: 24 })
  try {
    await act(async () => setup.flush())
    await act(async () => {
      await setup.mockInput.typeText("v")
      await setup.mockInput.typeText("l")
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(setup.renderer.root.findDescendantById("composer")?.id).toBe(
      "composer",
    )

    await act(async () => {
      switchThread()
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(observed.activeThreadId).toBe(target)
    expect(observed.workspaces[target]?.interaction).toMatchObject({
      mode: "visual",
      surface: "composer",
    })
    const composer = setup.renderer.root.findDescendantById(
      "composer",
    ) as TextareaRenderable
    expect(composer.getSelection()).toBeNull()

    await act(async () => {
      await setup.mockInput.typeText("y")
      await Bun.sleep(0)
      await setup.flush()
    })
    expect(copies).toEqual([])
    expect(observed.workspaces[source]?.composer.text).toBe("abcd")
    expect(observed.workspaces[target]?.composer.text).toBe("WXYZ")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

for (const mode of ["normal", "insert"] as const) {
  test(`Ctrl-j/k focus directly in ${mode} without inserting or submitting`, async () => {
    let state = fixture()
    state = transitionWorkbench(state, {
      type: "composer.change",
      text: "draft survives",
      cursorOffset: 14,
    }).state
    if (mode === "insert")
      state = transitionWorkbench(state, {
        type: "interaction.command",
        command: { type: "mode.insert" },
      }).state
    const commands: Parameters<VimexUiController["dispatchInteraction"]>[0][] =
      []
    let submissions = 0
    const setup = await testRender(
      <VimexRoot
        state={state}
        controller={{
          ...inertController,
          dispatchInteraction(command) {
            commands.push(command)
          },
          submit() {
            submissions++
          },
        }}
      />,
      { width: 80, height: 24 },
    )
    try {
      await act(async () => setup.flush())
      await act(async () => {
        setup.mockInput.pressKey("k", { ctrl: true })
        await setup.flush()
      })
      await act(async () => {
        setup.mockInput.pressKey("j", { ctrl: true })
        await setup.flush()
      })
      expect(commands).toContainEqual({
        type: "focus.set",
        surface: "transcript",
      })
      expect(commands).toContainEqual({
        type: "focus.set",
        surface: "composer",
      })
      expect(
        (
          setup.renderer.root.findDescendantById(
            "composer",
          ) as TextareaRenderable
        ).plainText,
      ).toBe("draft survives")
      expect(submissions).toBe(0)
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

for (const surface of ["composer", "transcript"] as const) {
  test(`agent shortcuts work in ${surface} Normal mode without modifying the draft`, async () => {
    let initial = transitionWorkbench(fixture(), {
      type: "interaction.command",
      command: { type: "focus.set", surface },
    }).state
    initial = transitionWorkbench(initial, {
      type: "composer.change",
      text: "keep this draft",
      cursorOffset: 4,
    }).state
    let observed = initial
    const visits: string[] = []
    function Harness() {
      const [state, setState] = useState(initial)
      observed = state
      const controller = useMemo<VimexUiController>(
        () => ({
          ...inertController,
          returnToParent() {
            visits.push("parent")
          },
          cycleAgent(direction) {
            visits.push(direction)
          },
          dispatchInteraction(command) {
            setState(
              (current) =>
                transitionWorkbench(current, {
                  type: "interaction.command",
                  command,
                }).state,
            )
          },
          changeDraft(text, cursorOffset) {
            setState(
              (current) =>
                transitionWorkbench(current, {
                  type: "composer.change",
                  text,
                  cursorOffset,
                }).state,
            )
          },
        }),
        [],
      )
      return <VimexRoot state={state} controller={controller} />
    }
    const setup = await testRender(<Harness />, { width: 80, height: 24 })
    try {
      await act(async () => setup.flush())
      for (const key of ["\\", "[", "a", "]", "a", "ga"]) {
        await act(async () => {
          await setup.mockInput.typeText(key)
          await setup.flush()
        })
      }
      expect(visits).toEqual(["parent", "previous", "next"])
      expect(observed.workspaces[threadId("keys")]?.interaction.overlay).toBe(
        "agents",
      )
      expect(observed.workspaces[threadId("keys")]?.composer.text).toBe(
        "keep this draft",
      )
    } finally {
      await act(async () => setup.renderer.destroy())
    }
  })
}

import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState, useSyncExternalStore } from "react"
import { threadId } from "@vimex/conversation"
import {
  VimexController,
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function harness() {
  const commands: string[] = []
  let update!: (fn: (state: WorkbenchState) => WorkbenchState) => void
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: threadId("a"),
      title: "Work",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = {
    ...initial,
    machine: { id: "local" },
    machines: [
      { id: "local" },
      { id: "devbox", label: "Travel VM" },
      { id: "office" },
    ],
    connection: "disconnected",
  }
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "overlay.open", overlay: "machines" },
  }).state
  function Harness() {
    const [state, setState] = useState(initial)
    update = setState
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        executeNamedCommand(command) {
          commands.push(command)
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
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 80, height: 24 })
    await setup.flush()
  })
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(name, { ctrl })
      if (name === "ESCAPE")
        await new Promise((resolve) => setTimeout(resolve, 35))
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
    })
  }
  const type = async (text: string) => {
    await act(async () => {
      await setup.mockInput.typeText(text)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
    })
  }
  const result = async (error?: string) => {
    await act(async () => {
      update((s) => ({ ...s, machineManagement: { pending: false, error } }))
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
    })
  }
  return {
    ...setup,
    commands,
    key,
    type,
    result,
    update,
    frame: () => setup.captureCharFrame(),
    close: async () => {
      await act(async () => setup.renderer.destroy())
    },
  }
}

test("machine modal filters, chooses a host, and keeps local status visible", async () => {
  const h = await harness()
  try {
    expect(h.frame()).toContain("⌂ local · current")
    await h.key("i")
    await h.type("travel")
    expect(h.frame()).toContain("Travel VM (devbox)")
    expect(h.frame()).not.toContain("office")
    await h.key("RETURN")
    expect(h.commands).toEqual(["machine devbox"])
    await h.key("ESCAPE")
    expect(h.frame()).toContain("Machines")
    await h.key("ESCAPE")
    expect(h.frame()).not.toContain("Machines")
    expect(h.frame()).toContain("⌂ local · /work")
    expect(h.frame()).toContain("disconnected")
  } finally {
    await h.close()
  }
})

test("inline rename retains input after failed save and favorite sorting preserves selection", async () => {
  const h = await harness()
  try {
    await h.key("ARROW_DOWN")
    await h.key("r", true)
    expect(h.frame()).toContain("Display name: Travel VM")
    await h.type(" laptop")
    await h.key("RETURN")
    expect(h.commands).toEqual(["machine rename devbox Travel VM laptop"])
    expect(h.frame()).toContain("Saving")
    await h.result("disk full")
    expect(h.frame()).toContain("disk full")
    expect(h.frame()).toContain("Travel VM laptop")
    await h.key("RETURN")
    await h.result()
    expect(h.frame()).not.toContain("Display name:")
    await h.key("f", true)
    expect(h.commands.at(-1)).toBe("machine favorite devbox")
    await act(async () => {
      h.update((s) => ({
        ...s,
        machineManagement: { pending: false },
        machines: s.machines?.map((m) =>
          m.id === "devbox" ? { ...m, favorite: true } : m,
        ),
      }))
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
    expect(h.frame()).toContain("> ★ ☁︎ Travel VM (devbox)")
    await h.key("RETURN")
    expect(h.commands.at(-1)).toBe("machine devbox")
  } finally {
    await h.close()
  }
})

test("inline add and removal confirmation require submission and local stays protected", async () => {
  const h = await harness()
  try {
    await h.key("d")
    expect(h.frame()).toContain("local connection cannot be removed")
    expect(h.commands).toEqual([])
    await h.key("a")
    await h.type("travel")
    await h.key("RETURN")
    expect(h.frame()).toContain("SSH host (travel): travel")
    await h.key("RETURN")
    expect(h.commands).toEqual(["machine add travel travel"])
    await h.result()
    await h.key("ARROW_DOWN")
    await h.key("d")
    expect(h.frame()).toContain("Forget Travel VM (devbox)?")
    await h.key("ESCAPE")
    expect(h.commands).toHaveLength(1)
    await h.key("d")
    await h.key("RETURN")
    expect(h.commands.at(-1)).toBe("machine remove devbox")
    await h.result()
    expect(h.frame()).toContain("Machines")
  } finally {
    await h.close()
  }
})

test("favoriting a scrolled row keeps the reordered selection visible", async () => {
  const h = await harness()
  try {
    await act(async () => {
      h.update((s) => ({
        ...s,
        machines: Array.from({ length: 20 }, (_, i) => ({ id: `vm-${i}` })),
      }))
      await h.flush()
    })
    for (let i = 0; i < 15; i++) await h.key("ARROW_DOWN")
    expect(h.frame()).toContain("> ☁︎ vm-15")
    await h.key("f", true)
    await act(async () => {
      h.update((s) => ({
        ...s,
        machineManagement: { pending: false },
        machines: s.machines?.map((m) =>
          m.id === "vm-15" ? { ...m, favorite: true } : m,
        ),
      }))
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
    expect(h.frame()).toContain("> ★ ☁︎ vm-15")
  } finally {
    await h.close()
  }
})

test("slash, Ex, and leader routes open the same machine manager", async () => {
  const summary = {
    id: threadId("route"),
    title: "Route",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high" as const,
    status: "idle" as const,
  }
  const runtime = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: () => () => {},
    forkThread: async () => ({ summary, events: [] }),
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    renameThread: async () => {},
    updateSettings: async () => {},
  }
  const controller = new VimexController({
    conversation: runtime,
    connection: runtime,
    approvals: { resolveApproval: async () => {} },
    models: { listModels: async () => [] },
    resolveDirectory: (v) => v,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
    machines: {
      current: { id: "local" },
      list: () => [{ id: "local" }, { id: "devbox" }],
      open: async () => {
        throw new Error("unused")
      },
    },
  })
  await controller.initialize("/work")
  function Harness() {
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let h!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    h = await testRender(<Harness />, { width: 80, height: 24 })
    await h.flush()
  })
  const key = async (name: string) => {
    await act(async () => {
      h.mockInput.pressKey(name)
      if (name === "ESCAPE") await Bun.sleep(35)
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
  }
  const type = async (value: string) => {
    await act(async () => {
      await h.mockInput.typeText(value)
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
  }
  try {
    await key("i")
    await type("/machine")
    await key("RETURN")
    expect(h.captureCharFrame()).toContain("Machines")
    expect(h.captureCharFrame()).toContain("Machines")
    await key("ESCAPE")
    await key("ESCAPE")
    await type(":machine")
    await key("RETURN")
    expect(h.captureCharFrame()).toContain("Machines")
    await key("ESCAPE")
    await key("ESCAPE")
    await key(" ")
    await key("m")
    expect(h.captureCharFrame()).toContain("Machines")
  } finally {
    await act(async () => h.renderer.destroy())
    await controller.close()
  }
})

test("header identifies connecting destination and keeps connected status compact", async () => {
  const h = await harness()
  try {
    const show = async (patch: Partial<WorkbenchState>) => {
      await act(async () => {
        h.update((s) => ({ ...s, ...patch }))
        await h.flush()
      })
      await h.flush()
    }
    await show({
      connection: "connected",
      machineChanging: true,
      machineDestination: { id: "devbox", label: "Travel VM" },
    })
    expect(h.frame()).toContain("● connecting to ☁︎ Travel VM…")
    expect(h.frame()).not.toContain("● connected")
    // A failed switch clears the destination and retains the source connection.
    await show({ machineChanging: false, machineDestination: undefined })
    expect(h.frame()).toContain("● connected")
    expect(h.frame()).not.toContain("● connected ·")
    await show({ machine: { id: "devbox", label: "Travel VM" } })
    for (const connection of [
      "disconnected",
      "connecting",
      "error",
      "connected",
    ] as const) {
      await show({ connection })
      expect(h.frame()).toContain(
        connection === "connected"
          ? "● connected"
          : `● ${connection} · ☁︎ Travel VM`,
      )
      if (connection === "connected") {
        expect(h.frame()).not.toContain("● connected ·")
        expect(h.frame()).toContain("☁︎ Travel VM · /work")
      }
    }
  } finally {
    await h.close()
  }
})

import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useMemo, useState } from "react"
import { threadId } from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController, type VimexUiController } from "../contracts"

async function harness(
  overlay: "handoff" | "machines" = "handoff",
  size = { width: 80, height: 24 },
) {
  const browse: Array<string | undefined> = []
  const choose: Array<string | undefined> = []
  const favorites: string[] = []
  const isolated: string[] = []
  const commands: string[] = []
  let update!: (fn: (state: WorkbenchState) => WorkbenchState) => void
  let initial = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary: {
      id: threadId("a"),
      title: "Feature",
      cwd: "/local/app",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }).state
  initial = {
    ...initial,
    machine: { id: "local" },
    machines: [{ id: "devbox" }],
    handoffPicker: {
      sourceId: "local",
      targetId: "devbox",
      threadId: "a",
      cwd: "/local/app",
      loading: false,
      listing: {
        directory: "/work",
        parent: "/",
        preferredCwd: "/work/travel",
        entries: [
          {
            cwd: "/work/review",
            label: "review",
            kind: "worktree",
            branch: "main",
            dirty: false,
            favorite: true,
          },
          {
            cwd: "/work/travel",
            label: "travel",
            kind: "worktree",
            branch: "feature/login",
            dirty: false,
          },
          { cwd: "/work/more", label: "more", kind: "directory" },
        ],
      },
    },
  }
  initial = transitionWorkbench(initial, {
    type: "interaction.command",
    command: { type: "overlay.open", overlay },
  }).state
  function Harness() {
    const [state, setState] = useState(initial)
    update = setState
    const controller = useMemo<VimexUiController>(
      () => ({
        ...inertController,
        browseHandoffDestination(directory) {
          browse.push(directory)
        },
        chooseHandoffDestination(cwd, createIsolated) {
          choose.push(cwd)
          if (createIsolated && cwd) isolated.push(cwd)
        },
        favoriteHandoffDestination(cwd) {
          favorites.push(cwd)
        },
        executeNamedCommand(command) {
          commands.push(command)
        },
        dispatchInteraction(command) {
          setState(
            (s) =>
              transitionWorkbench(s, { type: "interaction.command", command })
                .state,
          )
        },
      }),
      [],
    )
    return <VimexRoot state={state} controller={controller} />
  }
  let h!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    h = await testRender(<Harness />, size)
    await h.flush()
  })
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      h.mockInput.pressKey(name, { ctrl })
      if (name === "ESCAPE") await Bun.sleep(35)
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
  }
  const type = async (text: string) => {
    await act(async () => {
      h.mockInput.typeText(text)
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
  }
  const state = async (fn: (s: WorkbenchState) => WorkbenchState) => {
    await act(async () => {
      update(fn)
      await h.flush()
    })
    await act(async () => {
      await h.flush()
    })
  }
  return {
    ...h,
    key,
    type,
    state,
    browse,
    choose,
    favorites,
    isolated,
    commands,
    frame: () => h.captureCharFrame(),
    close: async () => {
      await act(async () => h.renderer.destroy())
    },
  }
}

test("handoff separates browsing from explicit ready destination selection", async () => {
  const h = await harness()
  try {
    expect(h.frame()).toContain("Handoff to devbox")
    expect(h.frame()).toContain("> travel · feature/login · clean")
    expect(h.frame()).toContain("/work/travel")
    await h.key("f", true)
    expect(h.favorites).toEqual(["/work/travel"])
    await h.key("u")
    expect(h.choose).toEqual(["/work/travel"])
    await h.key("RETURN")
    expect(h.browse).toEqual(["/work/travel"])
    expect(h.choose).toHaveLength(1)
    await h.key("ARROW_DOWN")
    await h.key("ARROW_DOWN")
    await h.key("u")
    expect(h.choose).toHaveLength(1)
    await h.key("n")
    expect(h.choose).toHaveLength(1)
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/more")
    await h.key("ARROW_DOWN")
    await h.key("n")
    expect(h.choose.at(-1)).toBe("/work/travel")
    expect(h.isolated).toEqual(["/work/travel"])
    expect(h.choose).toHaveLength(2)
  } finally {
    await h.close()
  }
})

test("path completion browses on the destination and retains input after failure", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.type("/tr")
    await h.key("TAB")
    expect(h.browse).toEqual(["/work"])
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: {
          directory: "/work",
          entries: [{ cwd: "/work/travel", label: "travel", kind: "worktree" }],
        },
      },
    }))
    expect(h.frame()).toContain("Path: /work/travel/")
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/travel/")
    await h.state((s) => ({
      ...s,
      handoffPicker: { ...s.handoffPicker!, error: "Connection lost" },
    }))
    expect(h.frame()).toContain("Connection lost")
    expect(h.frame()).toContain("Path: /work/travel/")
    await h.key("ESCAPE")
    expect(h.frame()).toContain("Handoff to devbox")
    await h.key("ESCAPE")
    expect(h.frame()).not.toContain("Handoff to devbox")
    expect(h.choose).toEqual([])
    expect(h.commands).toEqual([])
  } finally {
    await h.close()
  }
})

test("search remains local and listing failures cannot create worktrees in an unknown base", async () => {
  const h = await harness()
  try {
    await h.key("/")
    await h.type("review")
    expect(h.frame()).not.toContain("feature/login")
    expect(h.browse).toEqual([])
    await h.key("RETURN")
    expect(h.browse).toEqual(["/work/review"])
    expect(h.choose).toEqual([])
    await h.key("ESCAPE")
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: undefined,
        error: "No configured repository",
      },
    }))
    await h.key("n")
    expect(h.choose).toEqual([])
  } finally {
    await h.close()
  }
})

test("machine modal h opens destination selection instead of switching machines", async () => {
  const h = await harness("machines")
  try {
    await h.key("h")
    expect(h.commands).toEqual(["handoff devbox"])
    expect(h.frame()).not.toContain("Machines")
    expect(h.choose).toEqual([])
  } finally {
    await h.close()
  }
})

test("late path completion never overwrites newer input", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.type("/tr")
    await h.key("TAB")
    await h.type("avel-other")
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: {
          directory: "/work",
          entries: [{ cwd: "/work/travel", label: "travel", kind: "worktree" }],
        },
      },
    }))
    expect(h.frame()).toContain("Path: /work/travel-other")
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/travel-other")
  } finally {
    await h.close()
  }
})

test("relative path completion uses the displayed destination directory", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.key("u", true)
    await h.type("tr")
    await h.key("TAB")
    expect(h.browse.at(-1)).toBe("/work")
  } finally {
    await h.close()
  }
})

test("slash handoff picker and command-mode cwd handoff reach the same transfer port", async () => {
  const { VimexController } = await import("@vimex/workbench")
  const { useSyncExternalStore } = await import("react")
  for (const route of ["slash-picker", "command-cwd"] as const) {
    const transferred: Array<string | undefined> = []
    const summary = {
      id: threadId("route"),
      title: "Feature",
      cwd: "/local/app",
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
      resolveDirectory: (value) => value,
      clipboard: { writeText: async () => {} },
      openUrl: async () => {},
      quit() {},
      machines: {
        current: { id: "local" },
        list: () => [{ id: "local" }, { id: "devbox" }],
        open: async () => {
          throw new Error("Unexpected plain switch")
        },
        listHandoffDestinations: async () => ({
          directory: "/remote",
          preferredCwd: "/remote/prepared",
          entries: [
            {
              cwd: "/remote/prepared",
              label: "prepared",
              kind: "worktree",
              dirty: false,
            },
          ],
        }),
        handoff: async (input) => {
          transferred.push(input.destinationCwd)
          return {
            machine: { id: "devbox" },
            cwd: input.destinationCwd!,
            threadId: "route",
            conversation: runtime,
            connection: runtime,
            approvals: { resolveApproval: async () => {} },
            models: { listModels: async () => [] },
          }
        },
      },
    })
    await controller.initialize("/local/app")
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
        await controller.settle()
        await h.flush()
      })
      await act(async () => {
        await h.flush()
      })
    }
    const type = async (value: string) => {
      await act(async () => {
        h.mockInput.typeText(value)
        await h.flush()
      })
      await act(async () => {
        await h.flush()
      })
    }
    try {
      if (route === "slash-picker") {
        await key("i")
        await type("/handoff devbox")
        await key("RETURN")
        expect(h.captureCharFrame()).toContain("Handoff to devbox")
        expect(transferred).toEqual([])
        await key("u")
      } else {
        await type(':handoff devbox --cwd "/remote/prepared"')
        await key("RETURN")
      }
      expect(transferred).toEqual(["/remote/prepared"])
      expect(controller.getSnapshot().machine?.id).toBe("devbox")
    } finally {
      await act(async () => h.renderer.destroy())
      await controller.close()
    }
  }
})

test("compact destination list reveals the selected workspace after long navigation", async () => {
  const h = await harness("handoff", { width: 60, height: 20 })
  try {
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: {
          directory: "/work",
          entries: Array.from({ length: 20 }, (_, i) => ({
            cwd: `/work/slot-${i}`,
            label: `slot-${i}`,
            kind: "worktree" as const,
            dirty: false,
          })),
        },
      },
    }))
    for (let i = 0; i < 19; i++) await h.key("ARROW_DOWN")
    expect(h.frame()).toContain("> slot-19")
    expect(h.frame()).toContain("n New isolated")
    await h.key("u")
    expect(h.choose).toEqual(["/work/slot-19"])
  } finally {
    await h.close()
  }
})

test("machine handoff closes the modal before current-machine validation", async () => {
  const h = await harness("machines")
  try {
    await h.state((s) => ({ ...s, machines: [{ id: "local" }] }))
    await h.key("h")
    expect(h.commands).toEqual(["handoff local"])
    expect(h.frame()).not.toContain("Machines")
  } finally {
    await h.close()
  }
})

test("quoted paths and repeated relative browsing resolve from displayed directory once", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.key("u", true)
    await h.type('"/prepared space"')
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/prepared space")
    await h.key("u", true)
    await h.type("child")
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/child")
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: { directory: "/work/child", entries: [] },
      },
    }))
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/child")
  } finally {
    await h.close()
  }
})

test("multiple completion matches extend common prefix and in-flight transfer blocks actions", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.key("u", true)
    await h.type("tr")
    await h.key("TAB")
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: {
          directory: "/work",
          entries: [
            {
              cwd: "/work/travel-a",
              label: "travel-a",
              kind: "worktree",
              dirty: true,
            },
            { cwd: "/work/travel-b", label: "travel-b", kind: "worktree" },
          ],
        },
      },
    }))
    expect(h.frame()).toContain("Path: /work/travel-")
    await h.key("ESCAPE")
    await h.key("u")
    await h.key("ARROW_DOWN")
    await h.key("u")
    expect(h.choose).toEqual([])
    expect(h.frame()).toContain("status unknown")
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        transferring: true,
        phase: "preparing",
      },
    }))
    await h.key("n")
    await h.key("ESCAPE")
    expect(h.choose).toEqual([])
    expect(h.frame()).toContain("Handoff to devbox")
  } finally {
    await h.close()
  }
})

test("narrow failed preflight keeps retry and close discoverable without allowing transfer", async () => {
  const h = await harness("handoff", { width: 60, height: 18 })
  try {
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        preflightError: true,
        error:
          "Error: This session has subagent history; transfer of the complete session tree is not available. Your source session remains unchanged.",
        listing: undefined,
      },
    }))
    expect(h.frame()).toContain("This session has subagent history")
    expect(h.frame()).toContain("unchanged.")
    expect(h.frame()).not.toContain("n New isolated")
    expect(h.frame()).not.toContain("w saved")
    expect(h.frame()).toContain("w retry")
    await h.key("u")
    await h.key("n")
    expect(h.choose).toEqual([])
    await h.key("w")
    expect(h.browse).toEqual([undefined])
    await h.key("ESCAPE")
    expect(h.frame()).not.toContain("Handoff to devbox")
  } finally {
    await h.close()
  }
})

test("editing hints advertise only executable handoff shortcuts", async () => {
  const h = await harness()
  try {
    await h.key("/")
    expect(h.frame()).toContain("Esc, then u to hand off")
    expect(h.frame()).not.toContain("u Handoff here")
    expect(h.frame()).not.toContain("n New isolated")
    await h.key("ESCAPE")
    await h.key("u")
    expect(h.choose).toEqual(["/work/travel"])
    await h.key("/")
    await h.type("n")
    expect(h.choose).toHaveLength(1)
    await h.key("ESCAPE")
    await h.key("p")
    expect(h.frame()).not.toContain("n New isolated")
    expect(h.frame()).not.toContain("Handoff here")
    expect(h.frame()).toContain("Tab complete")
  } finally {
    await h.close()
  }
})

test("new isolated worktree uses selected matching repository even when modified", async () => {
  const h = await harness()
  try {
    await h.state((s) => ({
      ...s,
      handoffPicker: {
        ...s.handoffPicker!,
        listing: {
          directory: "/home",
          entries: [
            {
              cwd: "/home/project",
              label: "project",
              kind: "worktree",
              dirty: true,
            },
          ],
        },
      },
    }))
    await h.key("u")
    expect(h.choose).toEqual([])
    await h.key("n")
    expect(h.choose).toEqual(["/home/project"])
    expect(h.isolated).toEqual(["/home/project"])
  } finally {
    await h.close()
  }
})

test("Esc closes failed preflight after hiding a path or filter editor", async () => {
  for (const editor of ["p", "/"]) {
    const h = await harness()
    try {
      await h.state((s) => ({
        ...s,
        handoffPicker: {
          ...s.handoffPicker!,
          loading: true,
          phase: "checking",
        },
      }))
      await h.key(editor)
      await h.type("pending input")
      await h.state((s) => ({
        ...s,
        handoffPicker: {
          ...s.handoffPicker!,
          loading: false,
          preflightError: true,
          error: "Cannot transfer this source yet",
          listing: undefined,
        },
      }))
      expect(h.frame()).toContain("w retry")
      await h.key("ESCAPE")
      expect(h.frame()).not.toContain("Handoff to devbox")
      expect(h.choose).toEqual([])
    } finally {
      await h.close()
    }
  }
})

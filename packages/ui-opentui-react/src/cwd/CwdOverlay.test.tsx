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
  overlay: "cwd" = "cwd",
  size = { width: 80, height: 24 },
) {
  const browse: Array<string | undefined> = []
  const choose: Array<string | undefined> = []
  const favorites: string[] = []
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
    cwdPicker: {
      threadId: "a",
      cwd: "/local/app",
      loading: false,
      listing: {
        directory: "/work",
        parent: "/",
        entries: [
          {
            cwd: "/work/review",
            label: "review",
          },
          {
            cwd: "/work/travel",
            label: "travel",
          },
          { cwd: "/work/more", label: "more" },
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
        browseCwd(directory) {
          browse.push(directory)
        },
        chooseCwd(cwd) {
          choose.push(cwd)
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
    commands,
    frame: () => h.captureCharFrame(),
    close: async () => {
      await act(async () => h.renderer.destroy())
    },
  }
}

test("cwd picker keeps browsing separate from choosing and owns path editing keys", async () => {
  const h = await harness()
  try {
    expect(h.frame()).toContain("Working directory")
    await h.key("RETURN")
    expect(h.browse).toEqual(["/work/review"])
    expect(h.choose).toEqual([])
    await h.key("u")
    expect(h.choose).toEqual(["/work"])
    await h.key("p")
    await h.type("/new")
    await h.key("TAB")
    expect(h.browse.at(-1)).toBe("/work")
    await h.key("ESCAPE")
    expect(h.frame()).toContain("Working directory")
    expect(h.commands).toEqual([])
    await h.key("b")
    expect(h.browse.at(-1)).toBe("/")
  } finally {
    await h.close()
  }
})

test("path editor expands quoted absolute and home paths before browsing or completion", async () => {
  const h = await harness()
  try {
    await h.key("p")
    await h.key("a", true)
    await h.key("k", true)
    await h.type('"/tmp/space dir"')
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/tmp/space dir")
    await h.key("a", true)
    await h.key("k", true)
    await h.type('"~/project"')
    await h.key("TAB")
    expect(h.browse.at(-1)).toBe("~")
  } finally {
    await h.close()
  }
})

test("narrow picker keeps controls visible and repeated relative path browse stays stable", async () => {
  const h = await harness("cwd", { width: 60, height: 18 })
  try {
    expect(h.frame()).toContain("Working directory")
    expect(h.frame()).toContain("u / Ctrl-Enter")
    await h.key("p")
    await h.key("a", true)
    await h.key("k", true)
    await h.type("child")
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/child")
    await h.state((s) => ({
      ...s,
      cwdPicker: {
        ...s.cwdPicker!,
        listing: { directory: "/work/child", entries: [] },
      },
    }))
    await h.key("RETURN")
    expect(h.browse.at(-1)).toBe("/work/child")
  } finally {
    await h.close()
  }
})

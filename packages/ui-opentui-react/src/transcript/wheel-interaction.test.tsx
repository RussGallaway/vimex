import { expect, test } from "bun:test"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, Profiler } from "react"
import {
  itemId,
  threadId,
  turnId,
  type ConversationGateway,
} from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type RuntimeEvent,
} from "@vimex/workbench"
import { ConnectedVimexRoot } from "../index"

const thread = threadId("wheel-thread")
const answer = itemId("wheel-answer")
// Opt-in end-to-end profiling (includes native frames and React commits):
// VIMEX_PROFILE_TUI=1 bun test packages/ui-opentui-react/src/transcript/wheel-interaction.test.tsx -t 'full App'
const profileTest = process.env.VIMEX_PROFILE_TUI === "1" ? test : test.skip

async function wheelHarness(toolCount = 0) {
  let emit: (event: RuntimeEvent) => void = () => {}
  const summary = {
    id: thread,
    title: "Wheel interaction",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "idle" as const,
  }
  const runtime: ConversationGateway &
    ApprovalGateway &
    RuntimeConnection &
    ModelCatalog = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe(listener) {
      emit = listener
      return () => {
        emit = () => {}
      }
    },
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    updateSettings: async () => {},
    renameThread: async () => {},
    resolveApproval: async () => {},
    listModels: async () => [],
  }
  const controller = new VimexController({
    conversation: runtime,
    approvals: runtime,
    connection: runtime,
    models: runtime,
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work")
  emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: answer,
        turnId: turnId("wheel-turn"),
        kind: "assistant",
        markdown: Array.from(
          { length: 60 },
          (_, index) => `Line ${index} readable output`,
        ).join("\n\n"),
        status: "running",
      },
    },
  })
  for (let index = 0; index < toolCount; index++)
    emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: itemId(`scroll-command-${index}`),
          turnId: turnId("wheel-turn"),
          kind: "command",
          title: `Command ${index}`,
          detail: "first paragraph\n\nsecond paragraph",
          status: "complete",
        },
      },
    })
  const tailText = toolCount
    ? `Command ${toolCount - 1}`
    : "Line 59 readable output"
  const reactCommits: number[] = []
  function Harness() {
    const root = <ConnectedVimexRoot controller={controller} />
    return process.env.VIMEX_PROFILE_TUI === "1" ? (
      <Profiler
        id="app"
        onRender={(_id, _phase, duration) => reactCommits.push(duration)}
      >
        {root}
      </Profiler>
    ) : (
      root
    )
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 80, height: 24 })
    await setup.flush()
  })
  for (
    let count = 0;
    count < 20 && !setup.captureCharFrame().includes(tailText);
    count++
  ) {
    await act(async () => {
      await Bun.sleep(5)
      await setup.flush()
      await setup.renderOnce()
    })
  }
  expect(setup.captureCharFrame()).toContain(tailText)
  const workspace = () => controller.getSnapshot().workspaces[thread]!
  const keys = async (value: string) => {
    await act(async () => {
      await setup.mockInput.typeText(value)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  const close = async () => {
    await act(async () => setup.renderer.destroy())
    await controller.close()
  }
  return {
    ...setup,
    reactCommits,
    controller,
    emit: (event: RuntimeEvent) => {
      emit(event)
      void controller.settle()
    },
    workspace,
    keys,
    close,
  }
}

for (const mode of ["normal", "insert", "visual"] as const)
  test(`native wheel preserves ${mode} composer, scrolls precise rows, and detaches tail`, async () => {
    const h = await wheelHarness()
    try {
      await act(async () => {
        h.controller.changeDraft("keep draft", 3)
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "composer",
        })
        await h.flush()
      })
      if (mode === "insert") await h.keys("i")
      if (mode === "visual") await h.keys("vl")
      const composer = h.renderer.root.findDescendantById(
        "composer",
      ) as TextareaRenderable
      const scrollbox = h.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const cursor = composer.cursorOffset
      const selection = composer.getSelectedText()
      const transcriptCursor = h.workspace().transcript.cursor
      const wheel = async (direction: "up" | "down", count = 1) => {
        await act(async () => {
          for (let i = 0; i < count; i++)
            await h.mockMouse.scroll(
              scrollbox.x + 10,
              scrollbox.y + 3,
              direction,
            )
          await h.flush()
          await h.renderOnce()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
      }
      const bottom = scrollbox.scrollTop
      expect(bottom).toBeGreaterThan(30)
      await wheel("up")
      expect(scrollbox.scrollTop).toBe(bottom - 1)
      await wheel("up", 8)
      expect(scrollbox.scrollTop).toBe(bottom - 9)
      expect(h.workspace().transcript.viewport.kind).toBe("point")
      expect(h.workspace().transcript.cursor).toEqual(transcriptCursor)
      expect(h.workspace().interaction).toMatchObject({
        mode,
        surface: "composer",
      })
      expect(h.workspace().composer.text).toBe("keep draft")
      expect(composer.cursorOffset).toBe(cursor)
      expect(composer.getSelectedText()).toBe(selection)
      expect(composer.focused).toBe(true)
      await wheel("down", 15)
      expect(scrollbox.scrollTop).toBe(bottom)
      expect(h.workspace().transcript.viewport.kind).toBe("tail")
      expect(scrollbox.stickyScroll).toBe(true)
      await act(async () => {
        h.emit({
          type: "conversation",
          event: {
            type: "item.delta",
            threadId: thread,
            itemId: answer,
            delta: "\n\nNew streaming line\n\nAnother streaming line",
          },
        })
        await h.flush()
      })
      await act(async () => {
        await h.flush()
        await h.renderOnce()
      })
      expect(scrollbox.scrollTop).toBeGreaterThan(bottom)
      expect(h.workspace().transcript.viewport.kind).toBe("tail")
      await wheel("up", scrollbox.scrollTop + 5)
      expect(scrollbox.scrollTop).toBe(0)
      await wheel("down")
      expect(scrollbox.scrollTop).toBe(1)
    } finally {
      await h.close()
    }
  })

test("wheel and keyboard scrolling to the detached bottom resume following", async () => {
  const h = await wheelHarness()
  try {
    const scrollbox = h.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    const wheel = async (direction: "up" | "down", count = 1) => {
      await act(async () => {
        for (let index = 0; index < count; index++)
          await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, direction)
        await h.flush()
        await h.renderOnce()
      })
      await act(async () => {
        await h.flush()
        await h.renderOnce()
      })
    }
    await wheel("up", 3)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: answer,
          delta: "\n\nHidden until the reader returns",
        },
      })
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().transcript.unseenEntries).toBe(1)
    expect(h.captureCharFrame()).not.toContain(
      "Hidden until the reader returns",
    )

    await wheel("down", 3)
    expect(h.workspace().transcript.viewport.kind).toBe("tail")
    expect(h.workspace().transcript.unseenEntries).toBe(0)
    expect(h.captureCharFrame()).toContain("Hidden until the reader returns")

    await wheel("up", 2)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await act(async () => {
      h.mockInput.pressKey("e", { ctrl: true })
      h.mockInput.pressKey("e", { ctrl: true })
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().transcript.viewport.kind).toBe("tail")
  } finally {
    await h.close()
  }
})

test("a queued upward scroll still runs after a downward scroll reaches the tail", async () => {
  const h = await wheelHarness()
  try {
    const scrollbox = h.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    const bottom = scrollbox.scrollTop
    await act(async () => {
      h.mockInput.pressKey("y", { ctrl: true })
      await h.flush()
      await h.renderOnce()
    })
    expect(scrollbox.scrollTop).toBe(bottom - 1)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await act(async () => {
      h.mockInput.pressKey("e", { ctrl: true })
      h.mockInput.pressKey("y", { ctrl: true })
      await h.flush()
      await h.renderOnce()
    })
    expect(scrollbox.scrollTop).toBe(bottom - 1)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
  } finally {
    await h.close()
  }
})

test("wheel preserves transcript Visual selection while reading older output", async () => {
  const h = await wheelHarness()
  try {
    await h.keys("ggvll")
    const selected = h.workspace().transcript.selection
    const cursor = h.workspace().transcript.cursor
    const scrollbox = h.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    await act(async () => {
      await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, "down")
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(h.workspace().interaction).toMatchObject({
      surface: "transcript",
      mode: "visual",
    })
    expect(h.workspace().transcript.selection).toEqual(selected)
    expect(h.workspace().transcript.cursor).toEqual(cursor)
    expect(h.workspace().transcript.viewport.kind).toBe("point")
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: answer,
          delta: "\n\nDETACHED HIDDEN TAIL",
        },
      })
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(h.captureCharFrame()).not.toContain("DETACHED HIDDEN TAIL")
    expect(h.workspace().transcript.unseenEntries).toBe(1)
    await act(async () => {
      h.controller.transcript({ type: "viewport.tail" })
      await h.flush()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(h.captureCharFrame()).toContain("DETACHED HIDDEN TAIL")
    expect(h.workspace().transcript.unseenEntries).toBe(0)
    expect(scrollbox.stickyScroll).toBe(true)
    expect(h.workspace().transcript.viewport.kind).toBe("tail")
    const bottom = scrollbox.scrollTop
    await act(async () => {
      await h.mockMouse.scroll(scrollbox.x + 10, scrollbox.y + 3, "down")
      await h.flush()
      await h.renderOnce()
    })
    await act(async () => {
      await h.flush()
      await h.renderOnce()
    })
    expect(scrollbox.scrollTop).toBe(bottom)
    expect(scrollbox.stickyScroll).toBe(true)
    expect(h.workspace().transcript.viewport.kind).toBe("tail")
    await act(async () => {
      h.emit({
        type: "conversation",
        event: {
          type: "item.delta",
          threadId: thread,
          itemId: answer,
          delta: "\n\nSTILL FOLLOWING AFTER BOTTOM WHEEL",
        },
      })
      await h.flush()
      await h.renderOnce()
    })
    expect(h.captureCharFrame()).toContain("STILL FOLLOWING AFTER BOTTOM WHEEL")
  } finally {
    await h.close()
  }
})

profileTest(
  "full App half-page scrolling stays bounded on a large streamed answer",
  async () => {
    const h = await wheelHarness()
    try {
      await act(async () => {
        h.emit({
          type: "conversation",
          event: {
            type: "item.delta",
            threadId: thread,
            itemId: answer,
            delta:
              "\n\n" +
              Array.from(
                { length: 1500 },
                (_, index) =>
                  `Paragraph ${index} **readable output** ${"wide content ".repeat(5)}`,
              ).join("\n\n"),
          },
        })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "composer",
        })
        await h.flush()
      })
      await act(async () => {
        await h.flush()
        await h.renderOnce()
      })
      let transactions = 0
      const unsubscribe = h.controller.subscribe(() => transactions++)
      const samples: number[] = []
      const transactionCounts: number[] = []
      for (const key of ["u", "d", "u", "d", "u", "d"]) {
        transactions = 0
        const started = performance.now()
        await act(async () => {
          h.mockInput.pressKey(key, { ctrl: true })
          await h.flush()
          await h.renderOnce()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        samples.push(performance.now() - started)
        transactionCounts.push(transactions)
      }
      unsubscribe()
      console.log(
        "App Ctrl-U/D milliseconds:",
        samples.map((value) => Number(value.toFixed(2))),
        "transactions:",
        transactionCounts,
      )
      expect(Math.max(...samples)).toBeLessThan(1000)
      expect(Math.max(...transactionCounts)).toBeLessThanOrEqual(1)
      expect(h.workspace().interaction.surface).toBe("composer")
    } finally {
      await h.close()
    }
  },
)

test("Normal cursor remains visible while crossing the viewport inside one long answer", async () => {
  const h = await wheelHarness()
  try {
    await h.keys("gg")
    expect(h.renderer.getCursorState().visible).toBe(true)
    for (let index = 0; index < 20; index++) {
      await h.keys("j")
      expect(h.renderer.getCursorState().visible).toBe(true)
    }
  } finally {
    await h.close()
  }
})

profileTest(
  "measures full App scrolling with many historical Markdown items and preserves draft editing",
  async () => {
    const h = await wheelHarness()
    try {
      await act(async () => {
        for (let index = 0; index < 100; index++)
          h.emit({
            type: "conversation",
            event: {
              type: "item.started",
              threadId: thread,
              item: {
                id: itemId(`history-${index}`),
                turnId: turnId(`turn-${index}`),
                kind: "assistant",
                status: "complete",
                markdown: `## Historical answer ${index}\n\n${"Historical **Markdown** with a [reference](https://example.com).\n\n".repeat(8)}`,
              },
            },
          })
        h.controller.dispatchInteraction({
          type: "focus.set",
          surface: "composer",
        })
        await h.flush()
      })
      await act(async () => {
        await h.flush()
        await h.renderOnce()
      })
      let frameCount = 0
      let frameCallbacks = 0
      const originalEmit = h.renderer.emit.bind(h.renderer)
      h.renderer.emit = (event, ...args) => {
        if (event !== "frame") return originalEmit(event, ...args)
        const started = performance.now()
        const result = originalEmit(event, ...args)
        frameCount++
        frameCallbacks += performance.now() - started
        return result
      }
      const samples: object[] = []
      for (const key of ["u", "d", "u", "d"]) {
        frameCount = 0
        frameCallbacks = 0
        h.reactCommits.length = 0
        const started = performance.now()
        let dispatch = 0
        await act(async () => {
          h.mockInput.pressKey(key, { ctrl: true })
          dispatch = performance.now() - started
          await h.flush()
          await h.renderOnce()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        samples.push({
          key,
          dispatch: Number(dispatch.toFixed(2)),
          settled: Number((performance.now() - started).toFixed(2)),
          frameCount,
          frameCallbacks: Number(frameCallbacks.toFixed(2)),
          reactCommits: h.reactCommits.map((v) => Number(v.toFixed(2))),
        })
      }
      console.log("100-item App Ctrl-U/D timings:", samples)
      await h.keys("iDraft stays editable")
      expect(h.workspace().composer.text).toBe("Draft stays editable")
      expect(h.workspace().interaction).toMatchObject({
        mode: "insert",
        surface: "composer",
      })
    } finally {
      await h.close()
    }
  },
)

for (const toolCount of [1, 20])
  profileTest(
    `measures Shift-Tab folding ${toolCount} tools among 100 settled historical answers`,
    async () => {
      const h = await wheelHarness()
      const tool = itemId("fold-profile-tool")
      try {
        await act(async () => {
          for (let index = 0; index < 100; index++)
            h.emit({
              type: "conversation",
              event: {
                type: "item.started",
                threadId: thread,
                item: {
                  id: itemId(`fold-history-${index}`),
                  turnId: turnId(`fold-turn-${index}`),
                  kind: "assistant",
                  status: "complete",
                  markdown: `## Historical answer ${index}\n\n${"Historical **Markdown** with a [reference](https://example.com).\n\n".repeat(8)}`,
                },
              },
            })
          for (let index = 0; index < toolCount; index++)
            h.emit({
              type: "conversation",
              event: {
                type: "item.started",
                threadId: thread,
                item: {
                  id: index === 0 ? tool : itemId(`fold-profile-tool-${index}`),
                  turnId: turnId("fold-turn"),
                  kind: "command",
                  status: "complete",
                  title: "Read source",
                  detail: Array.from(
                    { length: 100 },
                    (_, index) => `${index}: result source line`,
                  ).join("\n"),
                },
              },
            })
          await h.flush()
        })
        for (let frame = 0; frame < 8; frame++)
          await act(async () => {
            await h.flush()
            await h.renderOnce()
          })
        const samples: object[] = []
        for (const folded of [false, true, false, true]) {
          const started = performance.now()
          await act(async () => {
            h.mockInput.pressKey("TAB", { shift: true })
            await h.flush()
            await h.renderOnce()
          })
          await act(async () => {
            await h.flush()
            await h.renderOnce()
          })
          samples.push({
            folded,
            milliseconds: Number((performance.now() - started).toFixed(2)),
          })
          expect(h.workspace().transcript.folded[tool]).toBe(folded)
        }
        console.log(
          `100-message App fold timings (${toolCount} tools):`,
          samples,
        )
      } finally {
        await h.close()
      }
    },
    30_000,
  )

for (const paragraphCount of [60, 1200])
  (paragraphCount === 1200 ? profileTest : test)(
    paragraphCount === 1200
      ? "profiles Ctrl-E/Y while a long answer changes between frames"
      : "Ctrl-E/Y preserves detached viewport and composer while active deltas arrive",
    async () => {
      const h = await wheelHarness()
      try {
        await act(async () => {
          h.emit({
            type: "conversation",
            event: {
              type: "item.delta",
              threadId: thread,
              itemId: answer,
              delta:
                "\n\n" +
                Array.from(
                  { length: paragraphCount },
                  (_, index) =>
                    `Streaming base ${index} **content** ${"wide ".repeat(8)}`,
                ).join("\n\n"),
            },
          })
          h.controller.changeDraft("keep composing during output", 5)
          h.controller.dispatchInteraction({
            type: "focus.set",
            surface: "composer",
          })
          await h.flush()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        const scrollbox = h.renderer.root.findDescendantById(
          "transcript",
        ) as ScrollBoxRenderable
        const composer = h.renderer.root.findDescendantById(
          "composer",
        ) as TextareaRenderable
        await act(async () => {
          h.mockInput.pressKey("u", { ctrl: true })
          await h.flush()
          await h.renderOnce()
        })
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        const composerCursor = composer.cursorOffset
        const samples: object[] = []
        let frameCount = 0
        let frameCallbacks = 0
        let streamFrameDurations: number[] = []
        const originalEmit = h.renderer.emit.bind(h.renderer)
        h.renderer.emit = (event, ...args) => {
          if (event !== "frame") return originalEmit(event, ...args)
          const started = performance.now()
          const result = originalEmit(event, ...args)
          const frameDuration = performance.now() - started
          frameCount++
          frameCallbacks += frameDuration
          streamFrameDurations.push(Number(frameDuration.toFixed(2)))
          return result
        }
        for (
          let index = 0;
          index < (paragraphCount === 1200 ? 12 : 3);
          index++
        ) {
          frameCount = 0
          frameCallbacks = 0
          streamFrameDurations = []
          h.reactCommits.length = 0
          const scrollBefore = scrollbox.scrollTop
          const deltaStarted = performance.now()
          await act(async () => {
            h.emit({
              type: "conversation",
              event: {
                type: "item.delta",
                threadId: thread,
                itemId: answer,
                delta: `\n\nLive chunk ${index} ${"new streaming markdown ".repeat(8)}`,
              },
            })
            await h.flush()
            await h.renderOnce()
          })
          const deltaSettled = performance.now() - deltaStarted
          expect(scrollbox.scrollTop).toBe(scrollBefore)
          const key = index % 2 ? "y" : "e"
          const started = performance.now()
          let dispatch = 0
          await act(async () => {
            h.mockInput.pressKey(key, { ctrl: true })
            dispatch = performance.now() - started
            await h.flush()
            await h.renderOnce()
          })
          await act(async () => {
            await h.flush()
            await h.renderOnce()
          })
          expect(scrollbox.scrollTop).toBe(
            scrollBefore + (key === "e" ? 1 : -1),
          )
          expect(h.workspace().composer.text).toBe(
            "keep composing during output",
          )
          expect(composer.cursorOffset).toBe(composerCursor)
          expect(h.workspace().interaction.surface).toBe("composer")
          samples.push({
            index,
            key,
            deltaSettled: Number(deltaSettled.toFixed(2)),
            dispatch: Number(dispatch.toFixed(2)),
            keySettled: Number((performance.now() - started).toFixed(2)),
            frameCount,
            frameCallbacks: Number(frameCallbacks.toFixed(2)),
            frameDurations: streamFrameDurations,
            reactCommits: h.reactCommits.map((v) => Number(v.toFixed(2))),
          })
        }
        if (paragraphCount === 1200)
          console.log("streaming Ctrl-E/Y timings:", samples)
        h.renderer.emit = originalEmit
      } finally {
        await h.close()
      }
    },
    30000,
  )

for (const [key, repeats] of [
  ["u", 8],
  ["y", 56],
] as const)
  test(`rapid Ctrl-${key} across unmounted tool cards keeps visible content and an anchor`, async () => {
    const h = await wheelHarness(100)
    try {
      const scroll = h.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      for (let frame = 0; frame < 4; frame++)
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
      const initialScrollTop = scroll.scrollTop
      const folded = h.workspace().transcript.folded
      await act(async () => {
        for (let index = 0; index < repeats; index++)
          h.mockInput.pressKey(key, { ctrl: true })
        await h.flush()
        await h.renderOnce()
      })
      // The destination must detach immediately, even outside mounted rows.
      expect(h.workspace().transcript.viewport.kind).toBe("point")
      for (let frame = 0; frame < 10; frame++) {
        await act(async () => {
          await h.flush()
          await h.renderOnce()
        })
        expect(h.captureCharFrame()).toMatch(/Command \d+/)
      }
      expect(scroll.scrollTop).toBeLessThan(initialScrollTop)
      expect(h.workspace().transcript.folded).toEqual(folded)
    } finally {
      await h.close()
    }
  })

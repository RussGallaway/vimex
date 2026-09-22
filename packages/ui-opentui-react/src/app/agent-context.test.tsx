import { threadId, itemId } from "@vimex/conversation"
import {
  initialWorkbench,
  transitionWorkbench,
  type WorkbenchState,
} from "@vimex/workbench"
import { VimexRoot } from "../index"
import { inertController } from "../contracts"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { FullscreenShell } from "./FullscreenShell"

for (const role of ["CHILD", "SIDE"] as const)
  for (const width of [44, 100]) {
    test(`${role} context and parent action remain visible at ${width} columns`, async () => {
      const setup = await testRender(
        <FullscreenShell
          title="Investigate transcript performance"
          threadRole={role}
          parentTitle="Parent session with a deliberately long title to test truncation"
          connection="connected"
          working={false}
          transcript={<box flexGrow={1} />}
          composer={<text>draft</text>}
          statusline={<text>NORMAL</text>}
        />,
        { width, height: 24 },
      )
      try {
        await act(async () => {
          await setup.flush()
          await setup.renderOnce()
        })
        const frame = setup.captureCharFrame()
        expect(frame).toContain(role)
        expect(frame).not.toContain("SUBAGENT")
        expect(frame).toContain("Parent:")
        expect(frame).toContain(
          role === "SIDE" ? "\\ Focus parent" : "\\ Back to parent",
        )
        const context = setup.renderer.root.findDescendantById(
          "agent-parent-context",
        )!
        expect(context.height).toBe(1)
      } finally {
        await act(async () => setup.renderer.destroy())
      }
    })
  }

test("thread roles follow ancestry across child navigation and side conversations", async () => {
  const parent = threadId("parent"),
    child = threadId("child"),
    side = threadId("side")
  let initial = initialWorkbench()
  for (const id of [side, child, parent])
    initial = transitionWorkbench(initial, {
      type: "thread.open",
      summary: {
        id,
        title: `${id} task`,
        cwd: "/tmp",
        model: "test",
        reasoningEffort: "medium",
        status: "idle",
      },
    }).state
  let update!: (state: WorkbenchState) => void
  function Harness() {
    const [state, setState] = useState(initial)
    update = setState
    return <VimexRoot state={state} controller={inertController} />
  }
  const setup = await testRender(<Harness />, { width: 100, height: 30 })
  const render = async (state: WorkbenchState) => {
    await act(async () => {
      update(state)
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    return setup.captureCharFrame()
  }
  try {
    await act(async () => setup.flush())
    expect(
      setup.renderer.root.findDescendantById("agent-context-badge"),
    ).toBeUndefined()
    const family = transitionWorkbench(initial, {
      type: "agent.link",
      link: {
        parentId: parent,
        childId: child,
        itemId: itemId("spawn"),
        relation: "spawned",
      },
    }).state
    let frame = await render(family)
    expect(frame).toContain("PARENT")
    expect(frame).not.toContain("Back to parent")
    const reply = transitionWorkbench(family, {
      type: "agent.link",
      link: {
        parentId: child,
        childId: parent,
        itemId: itemId("reply"),
        relation: "target",
      },
    }).state
    frame = await render({ ...reply, activeThreadId: child })
    expect(frame).toContain("CHILD")
    expect(frame).toContain("Back to parent")
    frame = await render({ ...reply, activeThreadId: parent })
    expect(frame).toContain("PARENT")
    expect(frame).not.toContain("CHILD")
    expect(frame).not.toContain("Back to parent")
    // Side identity takes precedence over spawned ancestry, including when maximized.
    const sideState = {
      ...family,
      agentRelationships: [
        ...family.agentRelationships,
        {
          parentId: parent,
          childId: side,
          itemId: itemId("side-spawn"),
          relation: "spawned" as const,
        },
      ],
      activeThreadId: side,
      sideChats: {
        [parent]: {
          parentId: parent,
          threadId: side,
          visible: true,
          maximized: true,
        },
      },
    }
    frame = await render(sideState)
    expect(frame).toContain("SIDE")
    expect(frame).toContain("Focus parent")
    expect(frame).not.toContain("CHILD")
    frame = await render({
      ...sideState,
      activeThreadId: parent,
      sideChats: {
        [parent]: { ...sideState.sideChats[parent]!, visible: false },
      },
    })
    expect(frame).toContain("PARENT")
    expect(frame).not.toContain("Focus parent")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

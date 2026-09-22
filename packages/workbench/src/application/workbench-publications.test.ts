import { expect, test } from "bun:test"
import {
  itemId,
  threadId,
  turnId,
  type ThreadSummary,
} from "@vimex/conversation"
import { transitionWorkbench } from "./reduce-workbench"
import { sideChatForChild, sideChatForThread } from "./side-chat"
import {
  initialWorkbench,
  type WorkbenchCommand,
  type WorkbenchState,
} from "./workbench-state"
import {
  captureWorkbenchLayout,
  captureWorkbenchPresentation,
  captureWorkbenchPublicationContext,
  threadForPresentation,
  workbenchLayoutChanged,
  workbenchPresentationChanged,
  type WorkbenchPublicationContext,
} from "./workbench-publications"

const parent = threadId("parent"),
  side = threadId("side")
const summary = (id: typeof parent): ThreadSummary => ({
  id,
  title: id,
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "high",
  status: "working",
})
const run = (state: WorkbenchState, command: WorkbenchCommand) =>
  transitionWorkbench(state, command).state

function splitState(): WorkbenchState {
  let state = run(initialWorkbench(), {
    type: "thread.open",
    summary: summary(parent),
  })
  state = run(state, { type: "thread.open", summary: summary(side) })
  state = {
    ...state,
    sideChats: {
      [parent]: {
        parentId: parent,
        threadId: side,
        visible: true,
        maximized: false,
      },
    },
  }
  for (const [thread, suffix] of [
    [parent, "parent"],
    [side, "side"],
  ] as const) {
    state = run(state, {
      type: "conversation.event",
      event: {
        type: "turn.started",
        threadId: thread,
        turnId: turnId(`${suffix}-turn`),
      },
    })
    state = run(state, {
      type: "conversation.event",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: itemId(`${suffix}-item`),
          turnId: turnId(`${suffix}-turn`),
          kind: "assistant",
          markdown: suffix,
          status: "running",
        },
      },
    })
  }
  return state
}

test("canonical token content is owned by presentation runtimes, not pane publications", () => {
  const before = splitState()
  const after = run(before, {
    type: "conversation.event",
    event: {
      type: "item.delta",
      threadId: parent,
      itemId: itemId("parent-item"),
      delta: " grows",
    },
  })
  expect(workbenchLayoutChanged(before, after)).toBe(false)
  expect(workbenchPresentationChanged(before, after, "main")).toBe(false)
  expect(workbenchPresentationChanged(before, after, "side")).toBe(false)
})

test("cached publication context keeps token settlements independent of retained relationship counts", () => {
  const base = splitState()
  const guardedSideChats = new Proxy(base.sideChats, {
    ownKeys() {
      throw new Error("side chats scanned")
    },
  })
  const guardedRelationships = new Proxy(base.agentRelationships, {
    get(target, property, receiver) {
      if (property === "find") throw new Error("agent relationships scanned")
      return Reflect.get(target, property, receiver)
    },
  })
  const changed = run(base, {
    type: "conversation.event",
    event: {
      type: "item.delta",
      threadId: parent,
      itemId: itemId("parent-item"),
      delta: " grows",
    },
  })
  const before = {
    ...base,
    sideChats: guardedSideChats,
    agentRelationships: guardedRelationships,
  }
  const after = {
    ...changed,
    sideChats: guardedSideChats,
    agentRelationships: guardedRelationships,
  }
  const candidate = base.sideChats[parent]!
  const beforeContext: WorkbenchPublicationContext = Object.freeze({
    activeThreadId: before.activeThreadId,
    sideChats: guardedSideChats,
    candidate,
    side: candidate,
    sideThreadReady: true,
  })
  const afterContext = captureWorkbenchPublicationContext(after, beforeContext)
  expect(afterContext.candidate).toBe(candidate)
  expect(
    workbenchLayoutChanged(before, after, beforeContext, afterContext),
  ).toBe(false)
  expect(
    workbenchPresentationChanged(
      before,
      after,
      "main",
      beforeContext,
      afterContext,
    ),
  ).toBe(false)
  expect(
    workbenchPresentationChanged(
      before,
      after,
      "side",
      beforeContext,
      afterContext,
    ),
  ).toBe(false)
})

test("pane-local state and focus invalidate only the semantic consumers", () => {
  const before = splitState()
  const parentDraft = run(before, {
    type: "composer.change",
    threadId: parent,
    text: "parent draft",
    cursorOffset: 4,
  })
  expect(workbenchLayoutChanged(before, parentDraft)).toBe(false)
  expect(workbenchPresentationChanged(before, parentDraft, "main")).toBe(true)
  expect(workbenchPresentationChanged(before, parentDraft, "side")).toBe(false)

  const focused = run(parentDraft, { type: "thread.switch", threadId: parent })
  expect(workbenchLayoutChanged(parentDraft, focused)).toBe(true)
  expect(workbenchPresentationChanged(parentDraft, focused, "main")).toBe(true)
  expect(workbenchPresentationChanged(parentDraft, focused, "side")).toBe(true)
})

test("semantic status changes invalidate their pane while background metadata stays scoped", () => {
  const before = splitState()
  const parentUsage = run(before, {
    type: "thread.summary.patch",
    threadId: parent,
    patch: { contextUsed: 500, contextLimit: 10_000 },
  })
  expect(workbenchPresentationChanged(before, parentUsage, "main")).toBe(true)
  expect(workbenchPresentationChanged(before, parentUsage, "side")).toBe(false)

  const approval = run(parentUsage, {
    type: "approval.received",
    approval: {
      id: "side-approval",
      threadId: side,
      kind: "command",
      title: "Run",
      detail: "command",
      choices: [{ id: "yes", label: "Yes" }],
      status: "pending",
    },
  })
  expect(workbenchPresentationChanged(parentUsage, approval, "main")).toBe(true)
  expect(workbenchPresentationChanged(parentUsage, approval, "side")).toBe(true)
})

test("a restored side association without its parent workspace cannot blank the main presentation", () => {
  const child = run(initialWorkbench(), {
    type: "thread.open",
    summary: summary(side),
  })
  const restored = {
    ...child,
    sideChats: {
      [parent]: {
        parentId: parent,
        threadId: side,
        visible: true,
        maximized: false,
      },
    },
  }
  expect(captureWorkbenchLayout(restored).side).toBeUndefined()
  expect(threadForPresentation(restored, "main")).toBe(side)
  expect(captureWorkbenchPresentation(restored, "main").activeThreadId).toBe(
    side,
  )
})

test("global connection and error state invalidate an empty main presentation", () => {
  const before = initialWorkbench()
  const after = { ...before, connection: "error" as const, error: "offline" }
  expect(workbenchPresentationChanged(before, after, "main")).toBe(true)
  expect(captureWorkbenchPresentation(after, "main")).toMatchObject({
    connection: "error",
    error: "offline",
  })
})

test("transcript yank commits its presentation-derived payload without rereading canonical content", () => {
  const before = splitState()
  const selected = run(
    run(before, {
      type: "transcript.command",
      threadId: parent,
      command: { type: "selection.begin", shape: "character" },
    }),
    {
      type: "transcript.command",
      threadId: parent,
      command: {
        type: "cursor.move",
        point: { itemId: itemId("parent-item"), graphemeOffset: 6 },
      },
    },
  )
  const transition = transitionWorkbench(selected, {
    type: "transcript.yank",
    threadId: parent,
    text: "displayed payload",
    shape: "line",
  })
  expect(
    transition.state.workspaces[parent]?.interaction.unnamedRegister,
  ).toEqual({ text: "displayed payload", shape: "line" })
  expect(
    transition.state.workspaces[parent]?.transcript.selection,
  ).toBeUndefined()
  expect(transition.effects).toEqual([
    { type: "clipboard.write", text: "displayed payload" },
  ])
})

test("global approval and question counts invalidate an empty main presentation", () => {
  const before = initialWorkbench()
  const approval = run(before, {
    type: "approval.received",
    approval: {
      id: "background-approval",
      threadId: parent,
      kind: "command",
      title: "Run",
      detail: "command",
      choices: [{ id: "yes", label: "Yes" }],
      status: "pending",
    },
  })
  expect(workbenchPresentationChanged(before, approval, "main")).toBe(true)

  const question = run(before, {
    type: "question.received",
    request: {
      id: "background-question",
      threadId: parent,
      turnId: turnId("background-turn"),
      questions: [
        {
          id: "choice",
          header: "Choose",
          question: "Choose",
          allowOther: false,
          secret: false,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    },
  })
  expect(workbenchPresentationChanged(before, question, "main")).toBe(true)
})

test("an unrelated retained side-chat mutation leaves active publications stable", () => {
  const before = splitState()
  const otherParent = threadId("other-parent"),
    otherSide = threadId("other-side")
  const after = {
    ...before,
    sideChats: {
      ...before.sideChats,
      [otherParent]: {
        parentId: otherParent,
        threadId: otherSide,
        visible: false,
        maximized: false,
      },
    },
  }
  expect(workbenchLayoutChanged(before, after)).toBe(false)
  expect(workbenchPresentationChanged(before, after, "main")).toBe(false)
  expect(workbenchPresentationChanged(before, after, "side")).toBe(false)
})

test("side associations are indexed once per immutable side-chat record", () => {
  const base = splitState()
  let scans = 0
  const sideChats = new Proxy(base.sideChats, {
    ownKeys(target) {
      scans++
      return Reflect.ownKeys(target)
    },
  })
  const state = { ...base, sideChats }
  expect(sideChatForThread(state, parent)).toBe(base.sideChats[parent])
  expect(sideChatForThread(state, side)).toBe(base.sideChats[parent])
  expect(sideChatForChild(state, side)).toBe(base.sideChats[parent])
  expect(scans).toBe(1)
  const replacement = {
    ...state,
    sideChats: {
      ...base.sideChats,
      [parent]: { ...base.sideChats[parent]!, visible: false },
    },
  }
  expect(sideChatForThread(replacement, side)).toBe(
    replacement.sideChats[parent],
  )
  expect(sideChatForThread(replacement, side)).not.toBe(base.sideChats[parent])
})

test("child-role indexing survives a thread that also owns a side chat", () => {
  const nested = threadId("nested")
  const child = threadId("child")
  const state = {
    ...initialWorkbench(),
    sideChats: {
      [child]: {
        parentId: child,
        threadId: nested,
        visible: true,
        maximized: false,
      },
      [parent]: {
        parentId: parent,
        threadId: child,
        visible: true,
        maximized: false,
      },
    },
  }
  expect(sideChatForThread(state, child)).toBe(state.sideChats[child])
  expect(sideChatForChild(state, child)).toBe(state.sideChats[parent])
})

test("an outer child-association change invalidates a pane even when the child owns another side chat", () => {
  const child = threadId("child"),
    nested = threadId("nested")
  let before = run(initialWorkbench(), {
    type: "thread.open",
    summary: summary(parent),
  })
  before = run(before, { type: "thread.open", summary: summary(child) })
  before = run(before, { type: "thread.open", summary: summary(nested) })
  before = run(before, { type: "thread.switch", threadId: child })
  before = {
    ...before,
    sideChats: {
      [child]: {
        parentId: child,
        threadId: nested,
        visible: true,
        maximized: false,
      },
      [parent]: {
        parentId: parent,
        threadId: child,
        visible: true,
        maximized: false,
        inheritedTurnIds: [turnId("old")],
      },
    },
  }
  const after = {
    ...before,
    sideChats: {
      ...before.sideChats,
      [parent]: {
        ...before.sideChats[parent]!,
        inheritedTurnIds: [turnId("new")],
      },
    },
  }
  expect(threadForPresentation(before, "main")).toBe(child)
  expect(workbenchPresentationChanged(before, after, "main")).toBe(true)
})

test("role and side parent title changes publish to their visible presentations", () => {
  const standalone = run(initialWorkbench(), {
    type: "thread.open",
    summary: summary(parent),
  })
  const family = run(standalone, {
    type: "agent.link",
    link: {
      parentId: parent,
      childId: side,
      itemId: itemId("spawn"),
      relation: "spawned",
    },
  })
  expect(workbenchPresentationChanged(standalone, family, "main")).toBe(true)
  const before = splitState()
  const renamed = run(before, {
    type: "thread.register",
    summary: { ...summary(parent), title: "Renamed parent" },
  })
  expect(workbenchPresentationChanged(before, renamed, "side")).toBe(true)
  const hidden = {
    ...before,
    activeThreadId: parent,
    sideChats: {
      [parent]: { ...before.sideChats[parent]!, visible: false },
    },
  }
  const noSide = { ...hidden, sideChats: {} }
  expect(workbenchPresentationChanged(noSide, hidden, "main")).toBe(true)
})

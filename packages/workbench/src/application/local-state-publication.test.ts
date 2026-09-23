import { expect, test } from "bun:test"
import { itemId, threadId, type ThreadSummary } from "@vimex/conversation"
import { VimexController } from "./workbench-controller"
import {
  sameLocalState,
  type LocalState,
  type SavedThreadView,
} from "./local-state"
import { transitionWorkbench } from "./reduce-workbench"
import { initialWorkbench, type WorkbenchState } from "./workbench-state"

test("saved view equality reuses unchanged fold maps and detects actual changes", () => {
  const folded = new Proxy(
    { [itemId("folded")]: true },
    {
      ownKeys() {
        throw new Error("Unchanged fold map was scanned")
      },
    },
  )
  const view: SavedThreadView = {
    draft: "",
    cursorOffset: 0,
    folded,
    cursor: { itemId: itemId("first"), graphemeOffset: 0 },
    viewport: { kind: "tail" },
    surface: "transcript",
    outbox: [],
    marks: {},
    jumps: { back: [], forward: [] },
  }
  const previous: LocalState = { version: 1, threads: { one: view } }
  const equivalent: LocalState = {
    version: 1,
    threads: {
      one: {
        ...view,
        cursor: { itemId: itemId("first"), graphemeOffset: 0 },
        viewport: { kind: "tail" },
        outbox: [],
        marks: {},
        jumps: { back: [], forward: [] },
      },
    },
  }
  expect(sameLocalState(previous, equivalent)).toBe(true)
  expect(
    sameLocalState(previous, {
      ...equivalent,
      threads: {
        one: {
          ...equivalent.threads.one!,
          cursor: { itemId: itemId("first"), graphemeOffset: 1 },
        },
      },
    }),
  ).toBe(false)
  expect(
    sameLocalState(
      {
        ...previous,
        threads: { one: { ...view, folded: { [itemId("folded")]: true } } },
      },
      {
        ...equivalent,
        threads: {
          one: { ...equivalent.threads.one!, folded: {} },
        },
      },
    ),
  ).toBe(false)
})

test("controller publishes once per navigation change without scanning 100k saved folds", () => {
  const published: LocalState[] = []
  const controller = new VimexController({
    conversation: {} as never,
    approvals: {} as never,
    connection: {} as never,
    models: {} as never,
    resolveDirectory: (_, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
    onLocalState: (state) => published.push(state),
  })
  const id = threadId("saved-view-navigation")
  const summary: ThreadSummary = {
    id,
    title: "Navigation",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "idle",
  }
  const opened = transitionWorkbench(initialWorkbench(), {
    type: "thread.open",
    summary,
  }).state
  const workspace = opened.workspaces[id]!
  const folded = new Proxy(
    Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [
        itemId(`folded-${index}`),
        true,
      ]),
    ),
    {
      ownKeys() {
        throw new Error("Navigation serialized the fold map")
      },
    },
  )
  const cursor = { itemId: itemId("first"), graphemeOffset: 0 }
  const first: WorkbenchState = {
    ...opened,
    workspaces: {
      ...opened.workspaces,
      [id]: {
        ...workspace,
        transcript: { ...workspace.transcript, folded, cursor },
      },
    },
  }
  const setState = (
    controller as unknown as {
      setState(next: WorkbenchState): void
    }
  ).setState.bind(controller)
  setState(first)
  expect(published).toHaveLength(1)

  const second: WorkbenchState = {
    ...first,
    workspaces: {
      ...first.workspaces,
      [id]: {
        ...first.workspaces[id]!,
        transcript: {
          ...first.workspaces[id]!.transcript,
          cursor: { itemId: cursor.itemId, graphemeOffset: 1 },
        },
      },
    },
  }
  setState(second)
  expect(published).toHaveLength(2)
  expect(published[1]?.threads[id]?.cursor?.graphemeOffset).toBe(1)

  setState({
    ...second,
    workspaces: {
      ...second.workspaces,
      [id]: {
        ...second.workspaces[id]!,
        transcript: {
          ...second.workspaces[id]!.transcript,
          cursor: { itemId: cursor.itemId, graphemeOffset: 1 },
        },
      },
    },
  })
  expect(published).toHaveLength(2)
})

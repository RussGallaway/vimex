import { expect, test } from "bun:test"
import { itemId, threadId, type ThreadSummary } from "@vimex/conversation"
import { assistantMessage } from "@vimex/testkit"
import { syncTranscriptItem } from "@vimex/transcript"
import { VimexController } from "./workbench-controller"
import {
  sameLocalState,
  captureLocalState,
  emptyLocalState,
  type LocalState,
  type SavedThreadView,
} from "./local-state"
import { transitionWorkbench } from "./reduce-workbench"
import {
  createWorkspace,
  initialWorkbench,
  type WorkbenchState,
} from "./workbench-state"

test("incremental local capture reuses unchanged views and equals complete capture", () => {
  const a = createWorkspace(threadId("a"))
  const b = createWorkspace(threadId("b"))
  let inspectMarks = false
  const marks = new Proxy(
    {},
    {
      ownKeys(target) {
        if (inspectMarks)
          throw new Error("Unchanged view marks were captured again")
        return Reflect.ownKeys(target)
      },
    },
  )
  const before: WorkbenchState = {
    ...initialWorkbench(),
    workspaces: {
      a: {
        ...a,
        composer: { ...a.composer, revision: 1 },
        transcript: { ...a.transcript, marks },
      },
      b: { ...b, composer: { ...b.composer, revision: 1 } },
    },
  }
  const previous = captureLocalState(before, emptyLocalState())
  const after: WorkbenchState = {
    ...before,
    workspaces: {
      ...before.workspaces,
      b: {
        ...before.workspaces.b!,
        composer: { ...b.composer, revision: 2, text: "new draft" },
      },
    },
  }
  inspectMarks = true
  const next = captureLocalState(after, previous, before)
  expect(next.threads.a).toBe(previous.threads.a)
  expect(next.threads.b).not.toBe(previous.threads.b)
  expect(next.threads.b?.draft).toBe("new draft")
  inspectMarks = false
  expect(next).toEqual(captureLocalState(after, previous))
  const canonicalOnly = {
    ...after,
    workspaces: {
      ...after.workspaces,
      b: { ...after.workspaces.b!, canonicalRevision: 10 },
    },
  }
  expect(captureLocalState(canonicalOnly, next, after).threads.b).toBe(
    next.threads.b,
  )
})

test("outbox mention changes are preserved by saved view equality", () => {
  const workspace = createWorkspace(threadId("a"))
  const before: WorkbenchState = {
    ...initialWorkbench(),
    workspaces: {
      a: {
        ...workspace,
        composer: {
          ...workspace.composer,
          revision: 1,
          outbox: [
            {
              id: "outgoing",
              text: "@file",
              intent: "next-turn",
              status: "queued",
              mentions: [
                {
                  id: "file",
                  kind: "file",
                  name: "file",
                  path: "/old",
                  marker: "@file",
                },
              ],
            },
          ],
        },
      },
    },
  }
  const previous = captureLocalState(before, emptyLocalState())
  const composer = before.workspaces.a!.composer
  const after = {
    ...before,
    workspaces: {
      a: {
        ...before.workspaces.a!,
        composer: {
          ...composer,
          outbox: composer.outbox.map((message) => ({
            ...message,
            mentions: message.mentions?.map((mention) => ({
              ...mention,
              path: "/new",
            })),
          })),
        },
      },
    },
  }
  const next = captureLocalState(after, previous, before)
  expect(next).toEqual(captureLocalState(after, previous))
  expect(sameLocalState(previous, next)).toBe(false)
})

test("incremental capture compares saved mark source offsets across canonical revisions", () => {
  const workspace = createWorkspace(threadId("a"))
  const transcript = syncTranscriptItem(
    workspace.transcript,
    assistantMessage("item", "hello"),
  )
  const before: WorkbenchState = {
    ...initialWorkbench(),
    workspaces: {
      a: {
        ...workspace,
        composer: { ...workspace.composer, revision: 1 },
        transcript: {
          ...transcript,
          marks: {
            a: {
              point: { itemId: itemId("item"), graphemeOffset: 0 },
              preferredScreenRow: 2,
            },
          },
        },
      },
    },
  }
  const previous = captureLocalState(before, emptyLocalState())
  const changed = syncTranscriptItem(
    before.workspaces.a!.transcript,
    assistantMessage("item", "**hello**"),
  )
  const after = {
    ...before,
    workspaces: { a: { ...before.workspaces.a!, transcript: changed } },
  }
  const next = captureLocalState(after, previous, before)
  expect(next.threads.a?.marks?.a?.sourceOffset).toBe(2)
  expect(next.threads.a).not.toBe(previous.threads.a)
  expect(next).toEqual(captureLocalState(after, previous))
})

test("incremental capture preserves unvisited saved views and removes retired and ephemeral views", () => {
  const workspace = createWorkspace(threadId("a"))
  const before = { ...initialWorkbench(), workspaces: { a: workspace } }
  const previous = captureLocalState(before, emptyLocalState())
  previous.threads.a = { ...previous.threads.a!, draft: "saved draft" }
  const untouched = captureLocalState(before, previous, before)
  expect(untouched.threads.a).toBe(previous.threads.a)
  const retired = { ...before, retiredSideThreadIds: [threadId("a")] }
  expect(captureLocalState(retired, previous, before)).toEqual(
    captureLocalState(retired, previous),
  )
  expect(captureLocalState(retired, previous, before).threads.a).toBeUndefined()
  const ephemeral = {
    ...before,
    sideChats: {
      parent: {
        parentId: threadId("parent"),
        threadId: threadId("a"),
        visible: true,
        maximized: false,
        ephemeral: true,
      },
    },
  }
  expect(captureLocalState(ephemeral, previous, before)).toEqual(
    captureLocalState(ephemeral, previous),
  )
  expect(
    captureLocalState(ephemeral, previous, before).threads.a,
  ).toBeUndefined()
})

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

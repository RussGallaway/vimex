import { expect, test } from "bun:test"
import { itemId, threadId, turnId, type Turn } from "@vimex/conversation"
import { transitionWorkbench } from "./reduce-workbench"
import {
  captureWorkbenchLifecycle,
  workbenchLifecycleChanged,
  workbenchLifecycleSignature,
} from "./workbench-observation"
import {
  initialWorkbench,
  type WorkbenchCommand,
  type WorkbenchState,
} from "./workbench-state"

const active = threadId("active")
const background = threadId("background")
const turn = turnId("turn")
const run = (state: WorkbenchState, command: WorkbenchCommand) =>
  transitionWorkbench(state, command).state

function fixture(): WorkbenchState {
  let state = initialWorkbench()
  for (const id of [background, active])
    state = run(state, {
      type: "thread.open",
      summary: {
        id,
        title: id,
        cwd: "/tmp",
        model: "test",
        reasoningEffort: "high",
        status: "idle",
      },
    })
  return state
}

function signature(state: WorkbenchState): string {
  return workbenchLifecycleSignature(captureWorkbenchLifecycle(state))
}

test("resume identities namespace threads by machine and withhold pending transitions", () => {
  const local = fixture()
  expect(captureWorkbenchLifecycle(local).resumeTarget).toMatchObject({
    machine: "local",
    thread: active,
    cwd: "/tmp",
  })
  const changing = { ...local, machineChanging: true }
  expect(workbenchLifecycleChanged(local, changing)).toBe(true)
  expect(captureWorkbenchLifecycle(changing).resumeTarget).toBeUndefined()
  const remote = { ...local, machine: { id: "remote" } }
  expect(workbenchLifecycleChanged(local, remote)).toBe(true)
  expect(captureWorkbenchLifecycle(remote).resumeTarget?.machine).toBe("remote")
  expect(signature(remote)).not.toBe(signature(local))
  const draft = { ...local, provisionalThreadIds: [active] }
  expect(captureWorkbenchLifecycle(draft).resumeTarget).toMatchObject({
    draftId: active,
  })
  expect(captureWorkbenchLifecycle(draft).resumeTarget?.thread).toBeUndefined()
})

test("lifecycle questions are scoped to the active thread and observe resolution", () => {
  const initial = fixture()
  const other = run(initial, {
    type: "question.received",
    request: { id: "other", threadId: background, turnId: turn, questions: [] },
  })
  expect(captureWorkbenchLifecycle(other).pendingQuestions).toBe(0)
  expect(signature(other)).toBe(signature(initial))
  const pending = run(other, {
    type: "question.received",
    request: { id: "active", threadId: active, turnId: turn, questions: [] },
  })
  expect(workbenchLifecycleChanged(other, pending)).toBe(true)
  expect(captureWorkbenchLifecycle(pending).pendingQuestions).toBe(1)
  expect(signature(pending)).not.toBe(signature(other))
  const resolved = run(pending, { type: "question.resolved", id: "active" })
  expect(workbenchLifecycleChanged(pending, resolved)).toBe(true)
  expect(signature(resolved)).toBe(signature(other))
})

test("turn starts and all completion outcomes publish semantic lifecycle changes", () => {
  const initial = fixture()
  const running = run(initial, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: active, turnId: turn },
  })
  expect(workbenchLifecycleChanged(initial, running)).toBe(true)
  expect(signature(running)).not.toBe(signature(initial))
  expect(captureWorkbenchLifecycle(running).turn).toEqual({
    id: turn,
    status: "running",
  })
  for (const outcome of ["complete", "failed", "interrupted"] as const) {
    const completed = run(running, {
      type: "conversation.event",
      event: {
        type: "turn.completed",
        threadId: active,
        turnId: turn,
        outcome,
      },
    })
    expect(workbenchLifecycleChanged(running, completed)).toBe(true)
    expect(signature(completed)).not.toBe(signature(running))
    const snapshot = captureWorkbenchLifecycle(completed)
    expect(snapshot.turn).toEqual({ id: turn, status: outcome })
    expect(Object.isFrozen(snapshot.turn)).toBe(true)
    // A settled turn remains available after activeTurnId is cleared.
    expect(
      completed.workspaces[active]?.conversation.activeTurnId,
    ).toBeUndefined()
  }
})

test("turn identity distinguishes consecutive completed turns with the same outcome", () => {
  const state = fixture()
  const workspace = state.workspaces[active]!
  const settled = (id: string): WorkbenchState => {
    const value: Turn = { id: turnId(id), status: "complete", itemIds: [] }
    return {
      ...state,
      workspaces: {
        ...state.workspaces,
        [active]: {
          ...workspace,
          conversation: {
            ...workspace.conversation,
            turnIds: [value.id],
            turns: { [value.id]: value },
          },
        },
      },
    }
  }
  const before = settled("first")
  const after = settled("second")
  expect(workbenchLifecycleChanged(before, after)).toBe(true)
  expect(signature(before)).not.toBe(signature(after))
})

test("background turn changes do not publish active-thread lifecycle", () => {
  const before = fixture()
  const after = run(before, {
    type: "conversation.event",
    event: { type: "turn.started", threadId: background, turnId: turn },
  })
  expect(workbenchLifecycleChanged(before, after)).toBe(false)
  expect(signature(after)).toBe(signature(before))
})

test("transcript deltas and token metadata do not wake lifecycle observers", () => {
  let before = run(fixture(), {
    type: "conversation.event",
    event: { type: "turn.started", threadId: active, turnId: turn },
  })
  const item = itemId("answer")
  before = run(before, {
    type: "conversation.event",
    event: {
      type: "item.started",
      threadId: active,
      item: {
        id: item,
        turnId: turn,
        kind: "assistant",
        status: "running",
        markdown: "",
      },
    },
  })
  const delta = run(before, {
    type: "conversation.event",
    event: {
      type: "item.delta",
      threadId: active,
      itemId: item,
      delta: "more",
    },
  })
  const metadata = run(delta, {
    type: "thread.summary.patch",
    threadId: active,
    patch: { contextUsed: 123, contextLimit: 1000 },
  })
  for (const after of [delta, metadata]) {
    expect(workbenchLifecycleChanged(before, after)).toBe(false)
    expect(signature(after)).toBe(signature(before))
  }
})

test("a workspace without a selected thread reports no turn or questions", () => {
  const snapshot = captureWorkbenchLifecycle(initialWorkbench())
  expect(snapshot.turn).toBeUndefined()
  expect(snapshot.pendingQuestions).toBe(0)
})

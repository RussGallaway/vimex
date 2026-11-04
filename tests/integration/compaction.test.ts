import { expect, test } from "bun:test"
import {
  VimexController,
  liveActivity,
  type RuntimeEvent,
  type RuntimeConnection,
} from "@vimex/workbench"
import {
  threadId,
  turnId,
  type ConversationGateway,
  type ThreadSummary,
} from "@vimex/conversation"

const id = threadId("compact-session"),
  other = threadId("other-session"),
  turn = turnId("compact-turn")
const summary = (value = id): ThreadSummary => ({
  id: value,
  title: value,
  cwd: "/tmp",
  model: "test",
  reasoningEffort: "medium",
  status: "idle",
})
async function harness() {
  let listener: (event: RuntimeEvent) => void = () => {}
  const requests: string[] = [],
    sends: string[] = [],
    steers: string[] = []
  const runtime: ConversationGateway & RuntimeConnection = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe: (fn) => {
      listener = fn
      return () => {}
    },
    listThreads: async () => [summary(), summary(other)],
    startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async (value) => ({ summary: summary(value), events: [] }),
    forkThread: async () => ({ summary: summary(other), events: [] }),
    compactThread: async (value) => {
      requests.push(value)
    },
    startTurn: async (_, text) => {
      sends.push(text)
      return []
    },
    steerTurn: async (_, __, text) => {
      steers.push(text)
    },
    interruptTurn: async () => {},
    renameThread: async () => {},
    updateSettings: async () => {},
  }
  const controller = new VimexController({
    conversation: runtime,
    connection: runtime,
    models: { listModels: async () => [] },
    resolveDirectory: (_, path) => path,
    approvals: { resolveApproval: async () => {} },
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit: () => {},
  })
  await controller.initialize("/tmp")
  return {
    controller,
    runtime,
    requests,
    sends,
    steers,
    emit: (event: RuntimeEvent) => listener(event),
  }
}

test("compaction queues submissions without sending before its turn completes", async () => {
  const h = await harness()
  h.controller.executeNamedCommand("compact")
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  expect(h.requests).toEqual([id])
  expect(liveActivity(h.controller.getSnapshot())).toEqual({
    working: true,
    label: "Compacting",
  })
  h.controller.changeDraft("keep this draft", 5)
  expect(h.controller.submit("next-turn")).toBe(true)
  h.controller.changeDraft("steer after compaction", 0)
  expect(h.controller.submit("steer")).toBe(true)
  await h.controller.settle()
  expect(h.sends).toEqual([])
  expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe("")
  expect(
    h.controller
      .getSnapshot()
      .workspaces[id]?.composer.outbox.map((message) => message.status),
  ).toEqual(["queued", "queued"])
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  await h.controller.settle()
  expect(h.sends).toEqual([])
  expect(h.steers).toEqual([])
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "complete",
    },
  })
  expect(liveActivity(h.controller.getSnapshot()).label).not.toBe("Compacting")
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
  await h.controller.settle()
  expect(h.sends).toEqual(["keep this draft"])
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turnId("next-turn") },
  })
  await h.controller.settle()
  expect(h.steers).toEqual(["steer after compaction"])
  await h.controller.close()
})

test("compaction targets focused session and remains visible on background sessions", async () => {
  const h = await harness()
  h.controller.openThread(other)
  await h.controller.settle()
  h.controller.executeCommand(":compact")
  await h.controller.settle()
  expect(h.requests).toEqual([other])
  h.controller.openThread(id)
  await h.controller.settle()
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  expect(liveActivity(h.controller.getSnapshot(), other).label).toBe(
    "Compacting",
  )
  h.emit({
    type: "compaction",
    phase: "completed",
    threadId: other,
    turnId: turn,
  })
  expect(liveActivity(h.controller.getSnapshot(), other).working).toBe(false)
  await h.controller.close()
})

test("failed compaction can retry and late request failures cannot clear a newer request", async () => {
  const h = await harness()
  let reject!: (error: Error) => void
  h.runtime.compactThread = () =>
    new Promise((_, fail) => {
      reject = fail
    })
  h.controller.executeNamedCommand("compact")
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: turn })
  h.runtime.compactThread = async () => {
    h.requests.push(id)
  }
  h.controller.executeNamedCommand("compact")
  reject(new Error("late failure"))
  await h.controller.settle()
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({
    type: "compaction",
    phase: "failed",
    threadId: id,
    error: "server failure",
  })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  expect(h.controller.getSnapshot().error).toBe("server failure")
  h.runtime.compactThread = async () => {
    throw new Error("request failure")
  }
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
  expect(h.controller.getSnapshot().error).toContain("request failure")
  await h.controller.close()
})

test("disconnect and restart clear compaction; active turns reject new compaction", async () => {
  const h = await harness()
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  h.controller.executeNamedCommand("compact")
  expect(h.requests).toEqual([])
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "complete",
    },
  })
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  h.emit({ type: "disconnected", message: "Disconnected" })
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
  h.controller.restart()
  await h.controller.settle()
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.controller.restart()
  await h.controller.settle()
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
  await h.controller.close()
})

test("auto compaction uses server item lifecycle and ignores late completed-turn starts", async () => {
  const h = await harness()
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({
    type: "compaction",
    phase: "completed",
    threadId: id,
    turnId: turnId("stale"),
  })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "interrupted",
    },
  })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  await h.controller.close()
})

test("stale turn failures and starts cannot settle or replace a newer compaction", async () => {
  const h = await harness()
  const old = turnId("previous-turn")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: old },
  })
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: old,
      outcome: "complete",
    },
  })
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  h.emit({
    type: "compaction",
    phase: "failed",
    threadId: id,
    turnId: old,
    error: "stale error",
  })
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: old })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  h.emit({
    type: "compaction",
    phase: "started",
    threadId: id,
    turnId: turnId("unknown-old"),
  })
  expect(h.controller.getSnapshot().compactingThreads[id]?.turnId).toBe(turn)
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "complete",
    },
  })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  await h.controller.close()
})

for (const phase of ["completed", "failed"] as const) {
  test(`compaction ${phase} without a turn releases the queue exactly once`, async () => {
    const h = await harness()
    h.controller.executeNamedCommand("compact")
    await h.controller.settle()
    h.controller.changeDraft("after compaction", 0)
    expect(h.controller.submit("next-turn")).toBe(true)
    h.controller.changeDraft("new unsent draft", 0)
    h.emit({ type: "compaction", phase, threadId: id })
    h.emit({ type: "compaction", phase, threadId: id })
    await h.controller.settle()
    expect(h.sends).toEqual(["after compaction"])
    expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe(
      "new unsent draft",
    )
    await h.controller.close()
  })
}

test("automatic compaction holds steering and queue edits until the matching completion", async () => {
  const h = await harness()
  h.emit({
    type: "conversation",
    event: { type: "turn.started", threadId: id, turnId: turn },
  })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  for (const text of ["remove me", "edit me", "steer later"]) {
    h.controller.changeDraft(text, 0)
    expect(h.controller.submit("steer")).toBe(true)
  }
  const queued = h.controller.getSnapshot().workspaces[id]!.composer.outbox
  expect(h.controller.removeQueuedOutgoing(queued[0]!.id)).toBe(true)
  expect(h.controller.unqueueOutgoing(queued[1]!.id)).toBe(true)
  h.emit({
    type: "compaction",
    phase: "completed",
    threadId: id,
    turnId: turnId("stale"),
  })
  await h.controller.settle()
  expect(h.steers).toEqual([])
  expect(h.sends).toEqual([])
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: turn })
  await h.controller.settle()
  expect(h.steers).toEqual(["steer later"])
  expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe(
    "edit me",
  )
  await h.controller.close()
})

test("in-flight send failure and retry cannot drain messages during compaction", async () => {
  const h = await harness()
  let rejectSend!: (error: Error) => void
  h.runtime.startTurn = () =>
    new Promise((_, reject) => {
      rejectSend = reject
    })
  h.controller.changeDraft("retry me", 0)
  h.controller.submit("next-turn")
  await Promise.resolve()
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  h.controller.changeDraft("later", 0)
  h.controller.submit("steer")
  rejectSend(new Error("send rejected"))
  await h.controller.settle()
  const failed = h.controller
    .getSnapshot()
    .workspaces[id]!.composer.outbox.find(
      (message) => message.status === "failed",
    )!
  expect(failed).toBeDefined()
  h.controller.retryOutgoing(failed.id)
  await h.controller.settle()
  expect(
    h.controller
      .getSnapshot()
      .workspaces[id]!.composer.outbox.map((message) => message.status),
  ).toEqual(["queued", "queued"])
  h.runtime.startTurn = async (_, text) => {
    h.sends.push(text)
    return []
  }
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: turn })
  await h.controller.settle()
  expect(h.sends).toEqual(["retry me"])
  await h.controller.close()
})

test("compaction turn completion without a turn-start notification releases queued input", async () => {
  const h = await harness()
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  h.controller.changeDraft("continue", 8)
  expect(h.controller.submit("next-turn")).toBe(true)
  h.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: id,
      turnId: turn,
      outcome: "complete",
    },
  })
  await h.controller.settle()
  expect(h.sends).toEqual(["continue"])
  await h.controller.close()
})

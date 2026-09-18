import { expect, test } from "bun:test"
import { VimexController, liveActivity, type RuntimeEvent, type RuntimeConnection } from "@vimex/workbench"
import { threadId, turnId, type ConversationGateway, type ThreadSummary } from "@vimex/conversation"

const id = threadId("compact-session"), other = threadId("other-session"), turn = turnId("compact-turn")
const summary = (value = id): ThreadSummary => ({ id: value, title: value, cwd: "/tmp", model: "test", reasoningEffort: "medium", status: "idle" })
async function harness() {
  let listener: (event: RuntimeEvent) => void = () => {}
  const requests: string[] = [], sends: string[] = []
  const runtime: ConversationGateway & RuntimeConnection = {
    connect: async () => {}, restart: async () => {}, close: async () => {}, subscribe: fn => { listener = fn; return () => {} },
    listThreads: async () => [summary(), summary(other)], startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async value => ({ summary: summary(value), events: [] }), forkThread: async () => ({ summary: summary(other), events: [] }),
    compactThread: async value => { requests.push(value) },
    startTurn: async (_, text) => { sends.push(text); return [] }, steerTurn: async () => {}, interruptTurn: async () => {}, renameThread: async () => {}, updateSettings: async () => {},
  }
  const controller = new VimexController({ conversation: runtime, connection: runtime, models: { listModels: async () => [] }, resolveDirectory: (_, path) => path, approvals: { resolveApproval: async () => {} }, clipboard: { writeText: async () => {} }, openUrl: async () => {}, quit: () => {} })
  await controller.initialize("/tmp")
  return { controller, runtime, requests, sends, emit: (event: RuntimeEvent) => listener(event) }
}

test("compaction ack stays animated, deduplicates, preserves drafts and settles on completion", async () => {
  const h = await harness()
  h.controller.executeNamedCommand("compact")
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  expect(h.requests).toEqual([id])
  expect(liveActivity(h.controller.getSnapshot())).toEqual({ working: true, label: "Compacting" })
  h.controller.changeDraft("keep this draft", 5)
  h.controller.submit("next-turn")
  h.controller.submit("steer")
  await h.controller.settle()
  expect(h.sends).toEqual([])
  expect(h.controller.getSnapshot().workspaces[id]?.composer.text).toBe("keep this draft")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: id, turnId: turn } })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: id, turnId: turn, outcome: "complete" } })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
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
  expect(liveActivity(h.controller.getSnapshot(), other).label).toBe("Compacting")
  h.emit({ type: "compaction", phase: "completed", threadId: other, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot(), other).working).toBe(false)
  await h.controller.close()
})

test("failed compaction can retry and late request failures cannot clear a newer request", async () => {
  const h = await harness()
  let reject!: (error: Error) => void
  h.runtime.compactThread = () => new Promise((_, fail) => { reject = fail })
  h.controller.executeNamedCommand("compact")
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: turn })
  h.runtime.compactThread = async () => { h.requests.push(id) }
  h.controller.executeNamedCommand("compact")
  reject(new Error("late failure"))
  await h.controller.settle()
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({ type: "compaction", phase: "failed", threadId: id, error: "server failure" })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  expect(h.controller.getSnapshot().error).toBe("server failure")
  h.runtime.compactThread = async () => { throw new Error("request failure") }
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  expect(h.controller.getSnapshot().compactingThreads).toEqual({})
  expect(h.controller.getSnapshot().error).toContain("request failure")
  await h.controller.close()
})

test("disconnect and restart clear compaction; active turns reject new compaction", async () => {
  const h = await harness()
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: id, turnId: turn } })
  h.controller.executeNamedCommand("compact")
  expect(h.requests).toEqual([])
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: id, turnId: turn, outcome: "complete" } })
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
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: id, turnId: turn } })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: turnId("stale") })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: id, turnId: turn, outcome: "interrupted" } })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turn })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  await h.controller.close()
})

test("stale turn failures and starts cannot settle or replace a newer compaction", async () => {
  const h = await harness()
  const old = turnId("previous-turn")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: id, turnId: old } })
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: id, turnId: old, outcome: "complete" } })
  h.controller.executeNamedCommand("compact")
  await h.controller.settle()
  h.emit({ type: "compaction", phase: "failed", threadId: id, turnId: old, error: "stale error" })
  h.emit({ type: "compaction", phase: "completed", threadId: id, turnId: old })
  expect(liveActivity(h.controller.getSnapshot()).label).toBe("Compacting")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: id, turnId: turn } })
  h.emit({ type: "compaction", phase: "started", threadId: id, turnId: turnId("unknown-old") })
  expect(h.controller.getSnapshot().compactingThreads[id]?.turnId).toBe(turn)
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: id, turnId: turn, outcome: "complete" } })
  expect(liveActivity(h.controller.getSnapshot()).working).toBe(false)
  await h.controller.close()
})

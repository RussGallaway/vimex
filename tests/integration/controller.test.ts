import { test, expect } from "bun:test"
import { VimexController } from "@vimex/workbench"
import type { RuntimeEvent, RuntimeConnection, ModelCatalog } from "@vimex/workbench"
import type { SessionSnapshot, ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import { resolve } from "node:path"
type TestRuntime = ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog
import { threadId, turnId, itemId, type ConversationEvent, type ThreadSummary } from "@vimex/conversation"
import type { LocalState } from "@vimex/workbench"

const a = threadId("a"), b = threadId("b")
const summary = (id = a): ThreadSummary => ({ id, title: id, cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle" })
function harness(options: { localState?: LocalState; onState?: () => void } = {}) {
  let listener: (event: RuntimeEvent) => void = () => {}
  const starts: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  let turnCounter = 0
  const backend: TestRuntime = {
    connect: async () => {}, subscribe: fn => { listener = fn; return () => { listener = () => {} } },
    listThreads: async () => [summary(a), summary(b)], startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async id => ({ summary: summary(id), events: [] }),
    forkThread: async () => ({ summary: summary(threadId("fork")), events: [] }),
    startTurn: async (id, text) => { starts.push(text); return [{ type: "turn.started", threadId: id, turnId: turnId(`turn-${++turnCounter}`) }] },
    listModels: async () => [{ id: "test", label: "Test", efforts: ["low", "high"] }], updateSettings: async () => {},
    steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: async () => {}, renameThread: async () => {}, close: async () => {},
  }
  const controller = new VimexController({ conversation: backend, approvals: backend, connection: backend, models: backend, resolveDirectory: resolve, localState: options.localState, onState: options.onState, clipboard: { writeText: async text => { copied.push(text) } }, openUrl: async url => { opened.push(url) }, quit() {} })
  return { controller, backend, starts, copied, opened, emit: (event: RuntimeEvent) => listener(event) }
}

test("initializes session catalog without selecting background sessions; restores drafts on round-trip", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("draft A", 7)
  h.emit({ type: "summary", summary: summary(b) })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.changeDraft("draft B", 7)
  h.controller.openThread(a)
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("draft A")
  expect(h.controller.getSnapshot().workspaces[b]?.composer.text).toBe("draft B")
  await h.controller.close()
})

test("queued next turn drains once when active turn completes", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("first", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("second", 6)
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(h.starts).toEqual(["first"])
  const completed: ConversationEvent = { type: "turn.completed", threadId: a, turnId: turnId("turn-1"), outcome: "complete" }
  h.emit({ type: "conversation", event: completed })
  h.emit({ type: "conversation", event: completed })
  await h.controller.settle()
  expect(h.starts).toEqual(["first", "second"])
})

test("backend output leaves composer focus and semantic reading anchor intact", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("turn"), id = itemId("message")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id, turnId: turn, kind: "assistant", markdown: "Reading here", status: "running" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: id, graphemeOffset: 3 }, preferredScreenRow: 4, extend: false })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  h.controller.changeDraft("reply", 5)
  const anchor = h.controller.getSnapshot().workspaces[a]?.transcript.viewport
  h.emit({ type: "conversation", event: { type: "item.delta", threadId: a, itemId: id, delta: " while output grows" } })
  expect(h.controller.getSnapshot().workspaces[a]?.transcript.viewport).toEqual(anchor)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("reply")
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.mode).toBe("insert")
})

test("stale resume response cannot steal focus after a newer navigation", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = () => new Promise(resolve => { finish = resolve })
  h.controller.openThread(b)
  h.controller.openThread(a)
  finish({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
})

test("turn-start response cannot replay an older snapshot over completed live output", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.startTurn = async () => {
    const turn = turnId("fast-turn")
    h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
    h.emit({ type: "conversation", event: { type: "turn.completed", threadId: a, turnId: turn, outcome: "complete" } })
    return [{ type: "turn.started", threadId: a, turnId: turn }]
  }
  h.controller.changeDraft("quick", 5)
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId).toBeUndefined()
})

test("resume buffers live deltas until history is hydrated and coalesces concurrent resumes", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: (snapshot: SessionSnapshot) => void
  let calls = 0
  h.backend.resumeThread = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  h.controller.openThread(b)
  h.controller.openThread(b)
  const turn = turnId("resume-turn"), id = itemId("resume-message")
  h.emit({ type: "conversation", event: { type: "item.delta", threadId: b, itemId: id, delta: " new" } })
  finish({ summary: summary(b), events: [
    { type: "turn.started", threadId: b, turnId: turn },
    { type: "item.started", threadId: b, item: { id, turnId: turn, kind: "assistant", markdown: "old", status: "running" } },
  ] })
  await h.controller.settle()
  expect(calls).toBe(1)
  const item = h.controller.getSnapshot().workspaces[b]?.conversation.items[id]
  expect(item && "markdown" in item ? item.markdown : undefined).toBe("old new")
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
})

test("reasoning settings validate against the model and publish only after backend acknowledgement", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => { updates.push(settings) }
  h.controller.executeCommand(":thinking low")
  await h.controller.settle()
  expect(updates).toEqual([{ effort: "low" }])
  expect(h.controller.getSnapshot().summaries[a]?.reasoningEffort).toBe("low")
  h.controller.executeCommand(":thinking invented")
  await h.controller.settle()
  expect(updates).toHaveLength(1)
  expect(h.controller.getSnapshot().error).toContain("Unsupported reasoning effort")
  h.backend.updateSettings = async () => { throw new Error("backend denied") }
  h.controller.executeCommand(":thinking high")
  await h.controller.settle()
  expect(h.controller.getSnapshot().summaries[a]?.reasoningEffort).toBe("low")
})

test("disconnect invalidates transport-scoped approvals and direct copy uses the clipboard port", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.emit({ type: "approval", approval: { id: "approval", threadId: a, kind: "command", title: "Run", detail: "danger", choices: [{ id: "accept", label: "Accept" }], status: "pending" } })
  expect(h.controller.getSnapshot().approvals.order).toEqual(["approval"])
  h.emit({ type: "disconnected", message: "server exited" })
  expect(h.controller.getSnapshot().approvals.order).toEqual([])
  expect(h.controller.getSnapshot().connection).toBe("disconnected")
  h.controller.copyText("rendered selection")
  await h.controller.settle()
  expect(h.copied).toEqual(["rendered selection"])
})

test("closing during initialization prevents late hydration and is idempotent", async () => {
  let releaseConnect!: () => void
  let listCalls = 0
  let stateChanges = 0
  const h = harness({ onState: () => { stateChanges++ } })
  h.backend.connect = () => new Promise(resolve => { releaseConnect = resolve })
  h.backend.listThreads = async () => { listCalls++; return [summary(a)] }
  h.backend.close = async () => { releaseConnect() }
  const initialization = h.controller.initialize("/tmp")
  const closing = h.controller.close()
  expect(h.controller.close()).toBe(closing)
  await closing
  await initialization
  expect(listCalls).toBe(0)
  expect(stateChanges).toBe(0)
  expect(h.controller.getSnapshot().activeThreadId).toBeUndefined()
})

test("restored outbox is never resent until the user explicitly retries", async () => {
  const localState: LocalState = { version: 1, threads: { a: {
    draft: "", cursorOffset: 0, folded: {}, viewport: { kind: "tail" }, surface: "composer",
    outbox: [{ id: "uncertain", text: "possibly delivered", intent: "next-turn", status: "sending" }],
  } } }
  const h = harness({ localState })
  await h.controller.initialize("/tmp")
  expect(h.starts).toEqual([])
  expect(h.controller.getSnapshot().workspaces[a]?.composer.outbox[0]).toMatchObject({ id: "uncertain", status: "failed" })
  h.controller.retryOutgoing("uncertain")
  await h.controller.settle()
  expect(h.starts).toEqual(["possibly delivered"])
})

test("runtime questions and child relationships reach owned state and requests expire on disconnect", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const request = { id: "question", threadId: a, turnId: turnId("turn"), questions: [{ id: "choice", header: "Choice", question: "Which option?", allowOther: true, secret: false }] }
  const link = { parentId: a, childId: b, itemId: itemId("agent"), relation: "spawned" as const }
  h.emit({ type: "question.requested", request })
  h.emit({ type: "subagent.link", link })
  h.emit({ type: "subagent.link", link })
  expect(h.controller.getSnapshot().questions.question).toEqual(request)
  expect(h.controller.getSnapshot().agentRelationships).toEqual([link])
  h.emit({ type: "question.resolved", id: request.id })
  expect(h.controller.getSnapshot().questions).toEqual({})
  h.emit({ type: "question.requested", request })
  h.emit({ type: "disconnected", message: "closed" })
  expect(h.controller.getSnapshot().questions).toEqual({})
  expect(h.controller.getSnapshot().agentRelationships).toEqual([link])
})

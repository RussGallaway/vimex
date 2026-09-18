import { test, expect } from "bun:test"
import { VimexController } from "@vimex/workbench"
import type { RuntimeEvent, RuntimeConnection, ModelCatalog, PreferenceStore } from "@vimex/workbench"
import type { SessionSnapshot, ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import { resolve } from "node:path"
type TestRuntime = ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog
import { threadId, turnId, itemId, type ConversationEvent, type ThreadSummary } from "@vimex/conversation"
import type { LocalState } from "@vimex/workbench"

const a = threadId("a"), b = threadId("b")
const summary = (id = a): ThreadSummary => ({ id, title: id, cwd: "/tmp", model: "test", reasoningEffort: "high", status: "idle" })
function harness(options: { localState?: LocalState; onState?: () => void; preferences?: PreferenceStore } = {}) {
  let listener: (event: RuntimeEvent) => void = () => {}
  const starts: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  let turnCounter = 0
  const backend: TestRuntime = {
    restart: async () => {}, connect: async () => {}, subscribe: fn => { listener = fn; return () => { listener = () => {} } },
    listThreads: async () => [summary(a), summary(b)], startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async id => ({ summary: summary(id), events: [] }),
    forkThread: async () => ({ summary: summary(threadId("fork")), events: [] }),
    startTurn: async (id, text) => { starts.push(text); return [{ type: "turn.started", threadId: id, turnId: turnId(`turn-${++turnCounter}`) }] },
    listModels: async () => [{ id: "test", label: "Test", efforts: ["low", "high"] }], updateSettings: async () => {},
    steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: async () => {}, renameThread: async () => {}, close: async () => {},
  }
  const controller = new VimexController({ conversation: backend, approvals: backend, connection: backend, models: backend, resolveDirectory: resolve, localState: options.localState, onState: options.onState, preferences: options.preferences, clipboard: { writeText: async text => { copied.push(text) } }, openUrl: async url => { opened.push(url) }, quit() {} })
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

test("fork requires explicit confirmation and resolves assistant cursor to its user-message boundary", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("completed"), user = itemId("question"), answer = itemId("answer")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
  for (const [id, kind, markdown] of [[user, "user", "Original prompt"], [answer, "assistant", "Original response"]] as const) h.emit({ type: "conversation", event: { type: "item.completed", threadId: a, item: { id, turnId: turn, kind, markdown, status: "complete" } } })
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: a, turnId: turn, outcome: "complete" } })
  let forks = 0
  h.backend.forkThread = async (id, through) => { expect(id).toBe(a); expect(through).toBe(turn); forks++; return { summary: summary(threadId("fork")), events: [] } }
  h.controller.requestFork(answer)
  expect(h.controller.getSnapshot().pendingFork?.itemId).toBe(user)
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe("fork")
  expect(forks).toBe(0)
  h.controller.cancelFork()
  expect(h.controller.getSnapshot().pendingFork).toBeUndefined()
  h.controller.requestFork(answer)
  h.controller.confirmFork()
  await h.controller.settle()
  expect(forks).toBe(1)
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("fork"))
})

test("agent navigation returns to the exact parent draft and transcript state", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Parent draft", 5)
  const parent = h.controller.getSnapshot().workspaces[a]!
  h.emit({ type: "subagent.link", link: { parentId: a, childId: b, itemId: itemId("agent"), relation: "spawned" } })
  h.controller.openChildThread(b)
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.controller.changeDraft("Child draft", 4)
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]?.composer).toEqual(parent.composer)
  expect(h.controller.getSnapshot().workspaces[a]?.transcript).toEqual(parent.transcript)
  expect(h.controller.getSnapshot().workspaces[b]?.composer.text).toBe("Child draft")
})

test("question answers validate options, retain failed requests, and clear only after success", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const request = { id: "request", threadId: a, turnId: turnId("turn"), questions: [{ id: "q", header: "Choice", question: "Pick one", allowOther: false, secret: false, options: [{ label: "Yes", description: "Proceed" }] }] }
  h.emit({ type: "question.requested", request })
  let calls = 0, fail = true
  h.backend.respondToQuestions = async (_, answers) => { calls++; expect(answers).toEqual({ q: "Yes" }); if (fail) throw new Error("Disconnected") }
  h.controller.answerQuestions(request.id, { q: "invalid" })
  await h.controller.settle()
  expect(calls).toBe(0)
  h.controller.answerQuestions(request.id, { q: "Yes" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().questions.request).toEqual(request)
  fail = false
  h.controller.answerQuestions(request.id, { q: "Yes" })
  await h.controller.settle()
  expect(calls).toBe(2)
  expect(h.controller.getSnapshot().questions).toEqual({})
})

test("controlled restart rehydrates the active thread and preserves drafts without sending", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Keep this draft", 4)
  let restarts = 0
  h.backend.restart = async () => {
    restarts++
    h.emit({ type: "disconnected", message: "Restarting Codex app server", reason: "restart" })
    expect(h.controller.getSnapshot().connection).toBe("connecting")
  }
  h.emit({ type: "disconnected", message: "Server exited" })
  h.controller.restart()
  h.controller.restart()
  await h.controller.settle()
  expect(restarts).toBe(1)
  expect(h.controller.getSnapshot().connection).toBe("connected")
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("Keep this draft")
  expect(h.starts).toEqual([])
})

test("semantic search unfolds its target, URL choice resolves through the port, and reference preserves draft", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("rich"), turn = turnId("rich-turn")
  h.emit({ type: "conversation", event: { type: "item.completed", threadId: a, item: { id, turnId: turn, kind: "assistant", status: "complete", markdown: "First paragraph\n\nneedle [one](https://one.test) and [two](https://two.test)\n\nLast paragraph" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: id, graphemeOffset: 0 }, preferredScreenRow: 2, extend: false })
  h.controller.transcript({ type: "fold.set", itemId: id, folded: true })
  h.controller.executeCommand("/needle")
  let transcript = h.controller.getSnapshot().workspaces[a]!.transcript
  expect(transcript.search).toEqual({ query: "needle", direction: "forward" })
  expect(transcript.cursor?.graphemeOffset).toBe(17)
  expect(transcript.folded[id]).toBe(false)
  h.controller.transcript({ type: "url.open" })
  expect(h.controller.getSnapshot().urlChoices?.map(candidate => candidate.url)).toEqual(["https://one.test", "https://two.test"])
  h.controller.transcript({ type: "url.open", url: "https://two.test" })
  await h.controller.settle()
  expect(h.opened).toEqual(["https://two.test"])
  h.controller.changeDraft("My note", 7)
  h.controller.transcript({ type: "reference" })
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toContain("My note\n\n> needle [one](https://one.test)")
  expect(h.controller.getSnapshot().workspaces[a]!.interaction.mode).toBe("insert")
})

test("restart quarantines stale turn and resume responses and keeps uncertain text retryable", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finishTurn!: (events: ConversationEvent[]) => void
  h.backend.startTurn = () => new Promise(resolve => { finishTurn = resolve })
  h.controller.changeDraft("uncertain", 9)
  h.controller.submit("next-turn")

  const staleItem = itemId("stale-item"), staleTurn = turnId("stale-turn")
  let finishResume!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = id => id === b
    ? new Promise(resolve => { finishResume = resolve })
    : Promise.resolve({ summary: summary(id), events: [] })
  h.controller.openThread(b)
  h.emit({ type: "disconnected", message: "old runtime exited" })
  h.controller.restart()
  finishResume({ summary: summary(b), events: [
    { type: "turn.started", threadId: b, turnId: staleTurn },
    { type: "item.completed", threadId: b, item: { id: staleItem, turnId: staleTurn, kind: "assistant", markdown: "stale", status: "complete" } },
  ] })
  finishTurn([
    { type: "turn.started", threadId: a, turnId: staleTurn },
    { type: "item.completed", threadId: a, item: { id: staleItem, turnId: staleTurn, kind: "assistant", markdown: "stale", status: "complete" } },
  ])
  await h.controller.settle()

  expect(h.controller.getSnapshot().workspaces[a]?.conversation.items[staleItem]).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[b]?.conversation.items[staleItem]).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[a]?.composer.outbox[0]).toMatchObject({ text: "uncertain", status: "failed" })
})

test("a stale question completion cannot delete a same-id request from the restarted runtime", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let finish!: () => void
  h.backend.respondToQuestions = () => new Promise(resolve => { finish = resolve })
  const old = { id: "same", threadId: a, turnId: turnId("old"), questions: [{ id: "q", header: "Old", question: "Old?", allowOther: true, secret: false }] }
  h.emit({ type: "question.requested", request: old })
  h.controller.answerQuestions(old.id, { q: "yes" })
  h.emit({ type: "disconnected", message: "restart" })
  h.controller.restart()
  const current = { ...old, turnId: turnId("new"), questions: [{ ...old.questions[0]!, header: "New" }] }
  h.emit({ type: "question.requested", request: current })
  finish()
  await h.controller.settle()
  expect(h.controller.getSnapshot().questions.same).toEqual(current)
})

test("approval commands are active-session scoped and successful RPC acknowledgement clears state", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const resolved: string[] = []
  h.backend.resolveApproval = async id => { resolved.push(id) }
  h.emit({ type: "approval", approval: { id: "background", threadId: b, kind: "command", title: "B", detail: "B", choices: [{ id: "accept", label: "Accept" }], status: "pending" } })
  h.emit({ type: "approval", approval: { id: "active", threadId: a, kind: "command", title: "A", detail: "A", choices: [{ id: "accept", label: "Accept" }], status: "pending" } })
  h.controller.executeCommand(":approve")
  await h.controller.settle()
  expect(resolved).toEqual(["active"])
  expect(h.controller.getSnapshot().approvals.byId.active).toBeUndefined()
  expect(h.controller.getSnapshot().approvals.byId.background?.status).toBe("pending")
  h.controller.resolveApproval("background", "accept")
  await h.controller.settle()
  expect(resolved).toEqual(["active"])
})

test("a queued steer waits for turn.started when start RPC acknowledges without events", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const steers: string[] = []
  h.backend.startTurn = async (_id, text) => { h.starts.push(text); return [] }
  h.backend.steerTurn = async (_id, _turn, text) => { steers.push(text) }
  h.controller.changeDraft("start", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("steer", 5)
  h.controller.submit("steer")
  await h.controller.settle()
  expect(h.starts).toEqual(["start"])
  expect(steers).toEqual([])
  expect(h.controller.getSnapshot().workspaces[a]?.composer.outbox[0]).toMatchObject({ text: "steer", status: "queued" })

  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turnId("real") } })
  await h.controller.settle()
  expect(steers).toEqual(["steer"])
})

test("RPC replay admits unseen items after a live turn start without regressing live items", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("raced"), live = itemId("live"), returned = itemId("returned")
  h.backend.startTurn = async () => {
    h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
    h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id: live, turnId: turn, kind: "assistant", markdown: "live newer", status: "running" } } })
    return [
      { type: "turn.started", threadId: a, turnId: turn },
      { type: "item.started", threadId: a, item: { id: live, turnId: turn, kind: "assistant", markdown: "old", status: "running" } },
      { type: "item.completed", threadId: a, item: { id: returned, turnId: turn, kind: "user", markdown: "prompt", status: "complete" } },
    ]
  }
  h.controller.changeDraft("go", 2)
  h.controller.submit("next-turn")
  await h.controller.settle()
  const conversation = h.controller.getSnapshot().workspaces[a]!.conversation
  expect(conversation.items[returned]).toMatchObject({ markdown: "prompt", status: "complete" })
  expect(conversation.items[live]).toMatchObject({ markdown: "live newer", status: "running" })
})

test("preference and thread-setting mutations preserve command order", async () => {
  let releasePreference!: () => void
  const preferenceGate = new Promise<void>(resolve => { releasePreference = resolve })
  const saved: Array<{ theme: string; syntaxTheme: string }> = []
  const h = harness({ preferences: {
    initial: { theme: "ember-tide", syntaxTheme: "theme" },
    async save(value) { saved.push(value); if (saved.length === 1) await preferenceGate },
  } })
  await h.controller.initialize("/tmp")
  h.controller.executeCommand(":theme nord")
  h.controller.executeCommand(":syntax kanagawa")
  await Promise.resolve(); await Promise.resolve()
  expect(saved).toEqual([{ theme: "nord", syntaxTheme: "theme" }])
  releasePreference()
  await h.controller.settle()
  expect(saved).toEqual([
    { theme: "nord", syntaxTheme: "theme" },
    { theme: "nord", syntaxTheme: "kanagawa" },
  ])
  expect(h.controller.getSnapshot().preferences).toEqual({ theme: "nord", syntaxTheme: "kanagawa" })

  let releaseModel!: () => void
  let markModelStarted!: () => void
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
  const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
  const updates: unknown[] = []
  h.backend.listModels = async () => [
    { id: "test", label: "Test", efforts: ["low"] },
    { id: "next", label: "Next", efforts: ["medium"] },
  ]
  h.backend.updateSettings = async (_id, settings) => { updates.push(settings); if (updates.length === 1) { markModelStarted(); await modelGate } }
  h.controller.executeCommand(":model next")
  h.controller.executeCommand(":thinking medium")
  await modelStarted
  expect(updates).toEqual([{ model: "next" }])
  releaseModel()
  await h.controller.settle()
  expect(updates).toEqual([{ model: "next" }, { effort: "medium" }])
  expect(h.controller.getSnapshot().summaries[a]).toMatchObject({ model: "next", reasoningEffort: "medium" })
})

test("late fork cannot steal focus and stale URL picker choices cannot open after a session switch", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("forkable"), user = itemId("fork-user"), rich = itemId("links")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
  h.emit({ type: "conversation", event: { type: "item.completed", threadId: a, item: { id: user, turnId: turn, kind: "user", markdown: "fork me", status: "complete" } } })
  h.emit({ type: "conversation", event: { type: "item.completed", threadId: a, item: { id: rich, turnId: turn, kind: "assistant", markdown: "[one](https://one.test) [two](https://two.test)", status: "complete" } } })
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: a, turnId: turn, outcome: "complete" } })
  let finishFork!: (snapshot: SessionSnapshot) => void
  h.backend.forkThread = () => new Promise(resolve => { finishFork = resolve })
  h.controller.requestFork(user)
  h.controller.confirmFork()
  h.controller.transcript({ type: "cursor.move", target: { itemId: rich, graphemeOffset: 3 }, preferredScreenRow: 0, extend: false })
  h.controller.transcript({ type: "url.open" })
  expect(h.controller.getSnapshot().urlChoices).toHaveLength(2)
  h.controller.openThread(b)
  await Promise.resolve(); await Promise.resolve()
  expect(h.controller.getSnapshot().urlChoices).toBeUndefined()
  h.controller.transcript({ type: "url.open", url: "https://one.test" })
  finishFork({ summary: summary(threadId("fork")), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.opened).toEqual([])
})

test("a completed turn arriving before its start acknowledgment still drains the queued prompt", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let resolveFirst!: (events: readonly ConversationEvent[]) => void
  h.backend.startTurn = async (_id, text) => {
    h.starts.push(text)
    return h.starts.length === 1 ? new Promise(resolve => { resolveFirst = resolve })
      : [{ type: "turn.started", threadId: a, turnId: turnId("second-turn") }]
  }
  h.controller.changeDraft("first", 5)
  h.controller.submit("next-turn")
  h.controller.changeDraft("second", 6)
  h.controller.submit("next-turn")
  const turn = turnId("fast-turn")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: a, turnId: turn, outcome: "complete" } })
  resolveFirst([{ type: "turn.started", threadId: a, turnId: turn }])
  await h.controller.settle()
  expect(h.starts).toEqual(["first", "second"])
  await h.controller.close()
})

test("rejected stale item events cannot regress the displayed transcript", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const item = { id: itemId("finished"), turnId: turnId("done-turn"), kind: "assistant" as const, status: "complete" as const, markdown: "Final answer" }
  h.emit({ type: "conversation", event: { type: "item.completed", threadId: a, item } })
  const before = h.controller.getSnapshot().workspaces[a]!.transcript.projectionById[item.id]
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { ...item, status: "running", markdown: "stale partial" } } })
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.conversation.items[item.id]).toEqual(item)
  expect(workspace.transcript.projectionById[item.id]).toBe(before)
  await h.controller.close()
})

test("favorites restore independently of history and selected-session rename does not switch threads", async () => {
  const h = harness({ localState: { version: 1, threads: {}, favoriteThreadIds: [b, b] } })
  const renamed: [string, string][] = []
  h.backend.renameThread = async (id, title) => { renamed.push([id, title]) }
  await h.controller.initialize("/tmp")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([b])
  h.controller.toggleFavorite(a)
  h.controller.toggleFavorite(b)
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([a])
  h.controller.renameThread(b, "  Saved research  ")
  await h.controller.settle()
  expect(renamed).toEqual([[b, "Saved research"]])
  expect(h.controller.getSnapshot().summaries[b]?.title).toBe("Saved research")
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.backend.renameThread = async () => { throw new Error("rename denied") }
  h.controller.renameThread(b, "Rejected name")
  await h.controller.settle()
  expect(h.controller.getSnapshot().summaries[b]?.title).toBe("Saved research")
  await h.controller.close()
})

test("model command completion and picker share a catalog while direct model selection preserves the draft", async () => {
  const h = harness()
  let loads = 0
  const changes: unknown[] = []
  h.backend.listModels = async () => { loads++; return [{ id: "test", label: "Test", efforts: ["high"] }, { id: "next", label: "Next", efforts: ["high"] }] }
  h.backend.updateSettings = async (_, settings) => { changes.push(settings) }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("keep my draft", 4)
  h.controller.dispatchInteraction({ type: "mode.command" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().availableModels?.map(model => model.id)).toEqual(["test", "next"])
  h.controller.executeCommand(":model next")
  await h.controller.settle()
  expect(changes).toEqual([{ model: "next" }])
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBeNull()
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe("models")
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("keep my draft")
  expect(loads).toBe(1)
  await h.controller.close()
})


test("stale model catalog cannot mutate settings after disconnect", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  let release!: (models: Awaited<ReturnType<ModelCatalog["listModels"]>>) => void
  let started!: () => void
  const requested = new Promise<void>(resolve => { started = resolve })
  h.backend.listModels = () => { started(); return new Promise(resolve => { release = resolve }) }
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => { updates.push(settings) }
  h.controller.executeCommand(":model next")
  await requested
  h.emit({ type: "disconnected", message: "connection lost" })
  release([{ id: "next", label: "Next", efforts: [] }])
  await h.controller.settle()
  expect(updates).toEqual([])
  expect(h.controller.getSnapshot().availableModels).toBeUndefined()
  await h.controller.close()
})

test("failed model discovery exposes an error and can be retried", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.listModels = async () => { throw new Error("Catalog unavailable") }
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().modelCatalogError).toBe("Catalog unavailable")
  h.backend.listModels = async () => [{ id: "test", label: "Test", efforts: [] }]
  h.controller.executeNamedCommand("model")
  await h.controller.settle()
  expect(h.controller.getSnapshot().modelCatalogError).toBeUndefined()
  expect(h.controller.getSnapshot().availableModels).toHaveLength(1)
  await h.controller.close()
})


test("model and thinking level apply together only after both arguments validate", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.backend.listModels = async () => [{ id: "sol-5.6", label: "Sol", efforts: ["low", "medium"] }]
  const updates: unknown[] = []
  h.backend.updateSettings = async (_, settings) => { updates.push(settings) }
  h.controller.changeDraft("draft stays", 5)
  h.controller.executeCommand(":model sol-5.6 medium")
  await h.controller.settle()
  expect(updates).toEqual([{ model: "sol-5.6", effort: "medium" }])
  expect(h.controller.getSnapshot().summaries[a]).toMatchObject({ model: "sol-5.6", reasoningEffort: "medium" })
  h.controller.executeCommand(":model sol-5.6 ultra")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("Unsupported reasoning effort")
  h.controller.executeCommand(":model sol-5.6 low extra")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("Usage:")
  expect(updates).toHaveLength(1)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("draft stays")
  await h.controller.close()
})

test("session commands switch exactly, favorite idempotently, and preserve drafts", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Keep this draft", 4)
  h.controller.executeCommand("favorite on")
  h.controller.executeCommand("favorite on")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([a])
  h.controller.executeCommand("favorite off")
  expect(h.controller.getSnapshot().favoriteThreadIds).toEqual([])
  h.controller.executeCommand("sessions b")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe("Keep this draft")
  h.backend.resumeThread = async () => { throw new Error("Unknown session: missing") }
  h.controller.executeCommand("sessions missing")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.controller.getSnapshot().error).toContain("Unknown session")
  h.controller.executeCommand("sessions")
  expect(h.controller.getSnapshot().workspaces[b]!.interaction.overlay).toBe("sessions")
  await h.controller.close()
})

test("command validation reports usage without sending or changing preferences", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("Unsent draft", 5)
  for (const command of ["submit accidental", "favorite maybe", "stop extra", "rename", "yank html", "theme nord extra"]) {
    h.controller.executeCommand(command)
    expect(h.controller.getSnapshot().error).toContain("Usage:")
    expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe("Unsent draft")
  }
  expect(h.starts).toEqual([])
  expect(h.controller.getSnapshot().preferences).toBeUndefined()
  h.controller.executeCommand("help model")
  expect(h.controller.getSnapshot().error).toContain("model [model-id] [thinking-level]")
  await h.controller.close()
})

test("follow resumes the live tail and slash model text loads argument choices", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("follow-answer")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id, turnId: turnId("turn"), kind: "assistant", markdown: "Reading here", status: "complete" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: id, graphemeOffset: 3 }, preferredScreenRow: 2, extend: false })
  h.controller.executeCommand("follow")
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.viewport).toEqual({ kind: "tail" })
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.cursor).toMatchObject({ itemId: id })
  h.controller.changeDraft("/model ", 7)
  await h.controller.settle()
  expect(h.controller.getSnapshot().availableModels?.map(model => model.id)).toEqual(["test"])
  expect(h.starts).toEqual([])
  await h.controller.close()
})

test("submit commands explicitly steer or queue the current draft", async () => {
  const h = harness()
  const steered: string[] = []
  h.backend.steerTurn = async (_thread, _turn, text) => { steered.push(text) }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("First", 5)
  h.controller.executeCommand("submit queue")
  await h.controller.settle()
  h.controller.changeDraft("Steering", 8)
  h.controller.executeCommand("submit steer")
  await h.controller.settle()
  expect(steered).toEqual(["Steering"])
  h.controller.changeDraft("Next turn", 9)
  h.controller.executeCommand("submit queue")
  await h.controller.settle()
  expect(h.starts).toEqual(["First"])
  expect(h.controller.getSnapshot().workspaces[a]!.composer.outbox).toContainEqual(expect.objectContaining({ text: "Next turn", intent: "next-turn", status: "queued" }))
  await h.controller.close()
})


test("visual command initializes a transcript selection and preserves the composer", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("selectable")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id, turnId: turnId("select-turn"), kind: "assistant", markdown: "Select this", status: "complete" } } })
  h.controller.changeDraft("Keep draft", 4)
  h.controller.executeCommand("visual")
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.interaction).toMatchObject({ surface: "transcript", mode: "visual" })
  expect(workspace.transcript.selection).toMatchObject({ anchor: workspace.transcript.cursor, head: workspace.transcript.cursor, shape: "character" })
  expect(workspace.composer.text).toBe("Keep draft")
  await h.controller.close()
})


test("copy command yanks the current block without requiring a Visual selection", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const id = itemId("copy-block")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id, turnId: turnId("copy-turn"), kind: "assistant", markdown: "A **clear** answer", status: "complete" } } })
  h.controller.executeCommand("copy markdown")
  await h.controller.settle()
  expect(h.copied).toEqual(["A **clear** answer"])
  expect(h.controller.getSnapshot().workspaces[a]!.interaction.unnamedRegister.text).toBe("A **clear** answer")
  h.controller.executeCommand("yank text")
  await h.controller.settle()
  expect(h.copied.at(-1)).toBe("A clear answer")
  await h.controller.close()
})

test("sessions command can resume an exact ID absent from the listed catalog", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const unlisted = threadId("0198d809-5492-7eb7-bbd5-dc531334eb9b")
  expect(h.controller.getSnapshot().summaries[unlisted]).toBeUndefined()
  h.controller.executeCommand(`sessions ${unlisted}`)
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(unlisted)
  await h.controller.close()
})

test("public jump and mark actions keep history per thread and normalize non-Visual focus", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const first = itemId("jump-a"), second = itemId("jump-b")
  for (const [id, markdown] of [[first, "first"], [second, "second"]] as const) h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id, turnId: turnId("jump-turn"), kind: "assistant", markdown, status: "complete" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: first, graphemeOffset: 1 }, preferredScreenRow: 4, extend: false })
  h.controller.transcript({ type: "viewport.anchor", point: { itemId: second, graphemeOffset: 0 }, preferredScreenRow: 8 })
  h.controller.transcript({ type: "mark.set", name: "a" })
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.marks.a).toEqual({ point: { itemId: first, graphemeOffset: 1 }, preferredScreenRow: 0 })
  h.controller.dispatchInteraction({ type: "mode.insert" })
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().workspaces[a]!.interaction.mode).toBe("insert")
  h.controller.transcript({ type: "viewport.anchor", point: { itemId: first, graphemeOffset: 1 }, preferredScreenRow: 7 })
  h.controller.transcript({ type: "jump", target: { itemId: second, graphemeOffset: 2 }, origin: { itemId: first, graphemeOffset: 1 }, originPreferredScreenRow: 11 })
  let workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.interaction).toMatchObject({ mode: "normal", surface: "transcript" })
  expect(workspace.transcript.cursor).toEqual({ itemId: second, graphemeOffset: 2 })
  expect(workspace.transcript.jumps.back.at(-1)?.preferredScreenRow).toBe(11)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().workspaces[a]!.transcript.cursor).toEqual({ itemId: first, graphemeOffset: 1 })
  h.controller.transcript({ type: "mark.jump", name: "a" })
  workspace = h.controller.getSnapshot().workspaces[a]!
  expect(workspace.transcript.cursor).toEqual(workspace.transcript.marks.a?.point)
  await h.controller.close()
})

test("interrupt deduplicates pending requests, retries failures, and waits for authoritative completion", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const turn = turnId("interrupt-lifecycle")
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turn } })
  h.controller.changeDraft("keep this draft", 4)
  let attempts = 0
  h.backend.interruptTurn = async () => { if (++attempts === 1) throw new Error("temporary stop failure") }
  h.controller.interrupt()
  h.controller.interrupt()
  await h.controller.settle()
  expect(attempts).toBe(1)
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId).toBe(turn)
  h.controller.interrupt()
  await h.controller.settle()
  h.controller.interrupt()
  await h.controller.settle()
  expect(attempts).toBe(2)
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBe(turn)
  expect(h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId).toBe(turn)
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: a, turnId: turn, outcome: "interrupted" } })
  expect(h.controller.getSnapshot().interruptingTurns[a]).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId).toBeUndefined()
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("keep this draft")
  await h.controller.close()
})

test("jump history interleaves parent and child positions, restores independent anchors, and branches", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  const first = itemId("parent-output"), second = itemId("child-output")
  const add = (thread: typeof a, id: typeof first) => h.emit({ type: "conversation", event: { type: "item.started", threadId: thread, item: { id, turnId: turnId("history"), kind: "assistant", markdown: "0123456789", status: "complete" } } })
  add(a, first)
  h.controller.transcript({ type: "cursor.move", target: { itemId: first, graphemeOffset: 1 }, preferredScreenRow: 3, extend: false })
  h.controller.transcript({ type: "viewport.anchor", point: { itemId: first, graphemeOffset: 0 }, preferredScreenRow: 7 })
  h.controller.changeDraft("parent draft", 4)
  h.emit({ type: "subagent.link", link: { parentId: a, childId: b, itemId: itemId("spawn"), relation: "spawned" } })
  h.controller.openChildThread(b)
  await h.controller.settle()
  add(b, second)
  h.controller.changeDraft("child draft", 2)
  h.controller.transcript({ type: "cursor.move", target: { itemId: second, graphemeOffset: 2 }, preferredScreenRow: 4, extend: false })
  h.controller.transcript({ type: "jump", target: { itemId: second, graphemeOffset: 8 } })
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset).toBe(2)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]!.transcript).toMatchObject({ cursor: { itemId: first, graphemeOffset: 1 }, viewport: { kind: "point", point: { itemId: first, graphemeOffset: 0 }, preferredScreenRow: 7 } })
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  expect(h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset).toBe(2)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset).toBe(8)
  h.controller.transcript({ type: "jump.back" })
  h.controller.transcript({ type: "jump", target: { itemId: second, graphemeOffset: 5 } })
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().workspaces[b]!.transcript.cursor?.graphemeOffset).toBe(5)
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe("parent draft")
  expect(h.controller.getSnapshot().workspaces[b]!.composer.text).toBe("child draft")
  await h.controller.close()
})

test("agent family cycling includes parent and siblings, wraps, and returns to immediate parent", async () => {
  const h = harness(), c = threadId("c"), grandchild = threadId("grandchild")
  await h.controller.initialize("/tmp")
  for (const [parentId, childId] of [[a, b], [a, c], [b, grandchild]] as const) h.emit({ type: "subagent.link", link: { parentId, childId, itemId: itemId(`spawn-${childId}`), relation: "spawned" } })
  for (const expected of [b, c, a]) {
    h.controller.cycleAgent("next")
    await h.controller.settle()
    expect(h.controller.getSnapshot().activeThreadId).toBe(expected)
  }
  h.controller.cycleAgent("previous")
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  h.controller.openThread(grandchild)
  await h.controller.settle()
  h.controller.returnToParent()
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  await h.controller.close()
})

test("failed and superseded session requests do not introduce ghost jump entries", async () => {
  const h = harness(), c = threadId("c")
  await h.controller.initialize("/tmp")
  let release!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = id => id === b ? new Promise(resolve => { release = resolve }) : Promise.resolve({ summary: summary(id), events: [] })
  h.controller.openThread(b)
  h.controller.openThread(c)
  release({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.back" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.backend.resumeThread = async () => { throw new Error("resume denied") }
  h.controller.openThread(threadId("failure"))
  await h.controller.settle()
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  await h.controller.close()
})

test("failed history resume after restart retains the entry for retry", async () => {
  const h = harness()
  await h.controller.initialize("/tmp")
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  const resume = h.backend.resumeThread
  h.backend.resumeThread = async id => { if (id === a) throw new Error("temporary resume failure"); return resume(id) }
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.backend.resumeThread = resume
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  await h.controller.close()
})

test("background streamed Markdown reprojects cross-agent history to the same source text", async () => {
  const h = harness(), output = itemId("stream-history")
  await h.controller.initialize("/tmp")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id: output, turnId: turnId("stream"), kind: "assistant", markdown: "**hello", status: "running" } } })
  const before = h.controller.getSnapshot().workspaces[a]!.transcript.projectionById[output]!
  const offset = before.plain.indexOf("h")
  h.controller.transcript({ type: "cursor.move", target: { itemId: output, graphemeOffset: offset }, preferredScreenRow: 5, extend: false })
  h.controller.openThread(b)
  await h.controller.settle()
  h.emit({ type: "conversation", event: { type: "item.delta", threadId: a, itemId: output, delta: "**" } })
  h.controller.transcript({ type: "jump.back" })
  const transcript = h.controller.getSnapshot().workspaces[a]!.transcript
  expect(transcript.projectionById[output]!.plain[transcript.cursor!.graphemeOffset]).toBe("h")
  expect(transcript.viewport).toMatchObject({ kind: "point", preferredScreenRow: 5, point: transcript.cursor })
  await h.controller.close()
})

test("repeated history keys during a slow resume traverse distinct entries in order", async () => {
  const h = harness(), c = threadId("c")
  await h.controller.initialize("/tmp")
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.openThread(c)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  const resume = h.backend.resumeThread
  let release!: (snapshot: SessionSnapshot) => void
  h.backend.resumeThread = id => id === b ? new Promise(resolve => { release = resolve }) : resume(id)
  h.controller.transcript({ type: "jump.back" })
  h.controller.transcript({ type: "jump.back" })
  release({ summary: summary(b), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(b)
  h.controller.transcript({ type: "jump.forward" })
  expect(h.controller.getSnapshot().activeThreadId).toBe(c)
  await h.controller.close()
})

test("history safely restores a session whose old transcript point no longer exists", async () => {
  const h = harness(), output = itemId("removed-output")
  await h.controller.initialize("/tmp")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: a, item: { id: output, turnId: turnId("removed-turn"), kind: "assistant", markdown: "removed", status: "complete" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: output, graphemeOffset: 3 }, preferredScreenRow: 4, extend: false })
  h.controller.openThread(b)
  await h.controller.settle()
  h.controller.restart()
  await h.controller.settle()
  h.controller.transcript({ type: "jump.back" })
  await h.controller.settle()
  const workspace = h.controller.getSnapshot().workspaces[a]!
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(workspace.transcript.cursor).toBeUndefined()
  expect(workspace.transcript.viewport).toEqual({ kind: "tail" })
  await h.controller.close()
})

test("goal commands use server state, serialize mutations, and preserve draft without invented prompts", async () => {
  const h = harness()
  const calls: unknown[] = []
  let goal: import("@vimex/conversation").ThreadGoal | null = null
  h.backend.getGoal = async id => { calls.push(["get", id]); return goal }
  h.backend.setGoal = async (id, update) => {
    calls.push(["set", id, update])
    goal = { objective: "old", status: "active", tokenBudget: null, tokensUsed: 42, timeUsedSeconds: 3, ...goal, ...update }
    return goal
  }
  h.backend.clearGoal = async id => { calls.push(["clear", id]); goal = null; return true }
  await h.controller.initialize("/tmp")
  h.controller.changeDraft("keep my draft", 4)
  h.controller.executeCommand("goal Fix tests")
  h.controller.executeCommand("goal pause")
  await h.controller.settle()
  expect(calls).toEqual([["set", a, { objective: "Fix tests", status: "active" }], ["set", a, { status: "paused" }]])
  expect(h.controller.getSnapshot().error).toContain("Goal [paused]: Fix tests")
  h.controller.executeCommand("goal")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("42 tokens")
  h.controller.executeCommand("goal --budget 30000 Improve parser")
  await h.controller.settle()
  expect(calls.at(-1)).toEqual(["set", a, { objective: "Improve parser", status: "active", tokenBudget: 30000 }])
  h.controller.executeCommand("goal clear")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toBe("Goal cleared")
  expect(h.controller.getSnapshot().workspaces[a]!.composer.text).toBe("keep my draft")
  expect(h.starts).toEqual([])
  await h.controller.close()
})

test("manual aliases open the offline guide without changing the draft", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.changeDraft("Preserve this", 4)
  for (const command of ["manual", "man", "help manual"]) {
    h.controller.executeCommand(command)
    expect(h.controller.getSnapshot().workspaces[a]?.interaction.overlay).toBe("manual")
    expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("Preserve this")
    h.controller.dispatchInteraction({ type: "overlay.close" })
  }
  await h.controller.close()
})

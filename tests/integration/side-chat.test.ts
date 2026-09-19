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
  const retired: string[] = []
  let forks = 0
  const copied: string[] = []
  const opened: string[] = []
  let turnCounter = 0
  const backend: TestRuntime = {
    restart: async () => {}, connect: async () => {}, subscribe: fn => { listener = fn; return () => { listener = () => {} } },
    listThreads: async () => [summary(a), summary(b)], startThread: async () => ({ summary: summary(), events: [] }),
    resumeThread: async id => ({ summary: summary(id), events: [] }),
    forkSideThread: async () => ({ summary: summary(threadId(`side-${++forks}`)), events: [] }),
    retireThread: async id => { retired.push(id) },
    forkThread: async () => ({ summary: summary(threadId("fork")), events: [] }),
    startTurn: async (id, text) => { starts.push(text); return [{ type: "turn.started", threadId: id, turnId: turnId(`turn-${++turnCounter}`) }] },
    listModels: async () => [{ id: "test", label: "Test", efforts: ["low", "high"] }], updateSettings: async () => {},
    steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: async () => {}, renameThread: async () => {}, close: async () => {},
  }
  const controller = new VimexController({ conversation: backend, approvals: backend, connection: backend, models: backend, resolveDirectory: resolve, localState: options.localState, onState: options.onState, preferences: options.preferences, clipboard: { writeText: async text => { copied.push(text) } }, openUrl: async url => { opened.push(url) }, quit() {} })
  return { controller, backend, starts, copied, opened, retired, emit: (event: RuntimeEvent) => listener(event) }
}

test("side transcript hides inherited context through streaming, restart, and persisted recovery", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  const side = threadId("side-clean"), inherited = turnId("inherited"), fresh = turnId("fresh")
  const oldItem = { id: itemId("old"), turnId: inherited, kind: "assistant" as const, status: "complete" as const, markdown: "Parent context" }
  const inheritedEvents: ConversationEvent[] = [
    { type: "turn.started", threadId: side, turnId: inherited },
    { type: "item.completed", threadId: side, item: oldItem },
    { type: "turn.completed", threadId: side, turnId: inherited, outcome: "complete" },
  ]
  const newEvent: ConversationEvent = { type: "item.completed", threadId: side, item: { ...oldItem, id: itemId("new"), turnId: fresh, markdown: "Side answer" } }
  h.backend.forkSideThread = async () => ({ summary: summary(side), events: inheritedEvents })
  h.controller.sideChat("open"); await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[side]?.transcript.order).toEqual([])
  expect(h.controller.getSnapshot().workspaces[side]?.conversation.items[oldItem.id]?.kind).toBe("assistant")
  h.emit({ type: "conversation", event: { type: "item.completed", threadId: side, item: { ...oldItem, markdown: "Replayed parent" } } })
  h.emit({ type: "conversation", event: newEvent })
  expect(h.controller.getSnapshot().workspaces[side]?.transcript.order).toEqual([itemId("new")])
  h.backend.resumeThread = async id => ({ summary: summary(id), events: id === side ? [...inheritedEvents, newEvent] : [] })
  h.controller.restart(); await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[side]?.transcript.order).toEqual([itemId("new")])
  const { captureLocalState, emptyLocalState, parseLocalState } = await import("@vimex/workbench")
  const saved = parseLocalState(JSON.parse(JSON.stringify(captureLocalState(h.controller.getSnapshot(), emptyLocalState()))))
  const restored = harness({ localState: saved })
  restored.backend.resumeThread = h.backend.resumeThread
  await restored.controller.initialize("/tmp", undefined, side)
  expect(restored.controller.getSnapshot().workspaces[side]?.transcript.order).toEqual([itemId("new")])
  await restored.controller.close()
  const legacy = harness({ localState: { ...saved, sideChats: { [a]: { ...saved.sideChats![a]!, inheritedTurnIds: undefined } } } })
  legacy.backend.resumeThread = async id => ({ summary: summary(id), events: id === side ? [...inheritedEvents, newEvent] : inheritedEvents.map(event => ({ ...event, threadId: a })) })
  await legacy.controller.initialize("/tmp", undefined, a)
  legacy.controller.sideChat("open"); await legacy.controller.settle()
  expect(legacy.controller.getSnapshot().workspaces[side]?.transcript.order).toEqual([itemId("new")])
  await legacy.controller.close(); await h.controller.close()
})

test("side chat forks while parent works; close preserves worker, drafts, and reopening", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.changeDraft("main draft", 3)
  h.emit({ type: "conversation", event: { type: "turn.started", threadId: a, turnId: turnId("main-turn") } })
  h.controller.sideChat("open", "How is it going?")
  await h.controller.settle()
  const side = threadId("side-1")
  expect(h.controller.getSnapshot().activeThreadId).toBe(side)
  expect(h.controller.getSnapshot().workspaces[a]?.conversation.activeTurnId).toBe(turnId("main-turn"))
  expect(h.starts).toEqual(["How is it going?"])
  h.controller.changeDraft("side draft", 4)
  h.controller.sideChat("close"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().sideChats[a]?.visible).toBe(false)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("main draft")
  expect(h.retired).toEqual([])
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: side, turnId: turnId("turn-1"), outcome: "complete" } })
  h.controller.sideChat("open"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(side)
  expect(h.controller.getSnapshot().workspaces[side]?.composer.text).toBe("side draft")
  await h.controller.close()
})

test("quit interrupts, archives, removes navigation targets, and next side forks anew", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  const calls: string[] = []
  h.backend.interruptTurn = async () => { calls.push("interrupt") }
  h.backend.retireThread = async () => { calls.push("archive") }
  h.controller.sideChat("open", "question"); await h.controller.settle()
  h.controller.sideChat("quit"); await h.controller.settle()
  expect(calls).toEqual(["interrupt", "archive"])
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().retiredSideThreadIds).toEqual([threadId("side-1")])
  h.controller.openThread(threadId("side-1")); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.transcript({ type: "jump.back" }); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  h.controller.sideChat("open"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("side-2"))
  await h.controller.close()
})

test("hide or quit during fork never focuses late side or sends canceled question", async () => {
  for (const action of ["close", "quit"] as const) {
    const h = harness(); await h.controller.initialize("/tmp")
    let complete!: (snapshot: SessionSnapshot) => void
    h.backend.forkSideThread = () => new Promise(resolve => { complete = resolve })
    h.controller.sideChat("open", "question")
    h.controller.sideChat(action)
    complete({ summary: summary(threadId("pending-side")), events: [] })
    await h.controller.settle()
    expect(h.controller.getSnapshot().activeThreadId).toBe(a)
    expect(h.starts).toEqual(action === "close" ? ["question"] : [])
    expect(h.retired).toEqual(action === "quit" ? ["pending-side"] : [])
    await h.controller.close()
  }
})

test("failed creation can retry and failed retirement leaves a usable side", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  const fork = h.backend.forkSideThread!
  h.backend.forkSideThread = async () => { throw Error("fork failed") }
  h.controller.sideChat("open"); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]).toBeUndefined()
  h.backend.forkSideThread = fork
  h.controller.sideChat("open"); await h.controller.settle()
  h.backend.retireThread = async () => { throw Error("archive failed") }
  h.controller.sideChat("quit"); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.threadId).toBe(threadId("side-1"))
  expect(h.controller.getSnapshot().sideChats[a]?.status).toBeUndefined()
  expect(h.controller.getSnapshot().retiredSideThreadIds).toEqual([])
  expect(h.controller.getSnapshot().error).toBe("archive failed")
  await h.controller.close()
})

test("quit waits for an in-flight submission and suppresses queued follow-ups", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  const side = threadId("side-1")
  let complete!: (events: readonly ConversationEvent[]) => void
  h.backend.startTurn = async (_id, text) => { h.starts.push(text); return new Promise(resolve => { complete = resolve }) }
  const calls: string[] = []
  h.backend.interruptTurn = async (_id, turn) => { calls.push(`interrupt ${turn}`) }
  h.backend.retireThread = async () => { calls.push("archive") }
  h.controller.changeDraft("pending", 7); h.controller.submit("next-turn")
  h.controller.sideChat("quit")
  expect(calls).toEqual([])
  complete([{ type: "turn.started", threadId: side, turnId: turnId("late-turn") }])
  await h.controller.settle()
  expect(calls).toEqual(["interrupt late-turn", "archive"])
  expect(h.controller.getSnapshot().sideChats[a]).toBeUndefined()
  await h.controller.close()
})

test("retired side tombstones survive local state and ignore late events", async () => {
  const { captureLocalState, emptyLocalState, parseLocalState } = await import("@vimex/workbench")
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  h.controller.sideChat("quit"); await h.controller.settle()
  const saved = parseLocalState(captureLocalState(h.controller.getSnapshot(), emptyLocalState()))
  expect(saved.retiredSideThreadIds).toEqual(["side-1"])
  const restored = harness({ localState: saved }); await restored.controller.initialize("/tmp")
  restored.emit({ type: "summary", summary: summary(threadId("side-1")) })
  restored.controller.openThread(threadId("side-1")); await restored.controller.settle()
  expect(restored.controller.getSnapshot().activeThreadId).toBe(a)
  expect(restored.controller.getSnapshot().summaries["side-1"]).toBeUndefined()
  await h.controller.close(); await restored.controller.close()
})

test("side pane focus, maximize, refresh preserve both drafts; restart subscribes hidden side", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  const side = threadId("side-1")
  h.controller.changeDraft("keep this draft", 2)
  h.controller.sideChat("parent"); await h.controller.settle()
  h.controller.changeDraft("parent draft", 3)
  h.controller.sideChat("cycle"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(side)
  h.controller.sideChat("maximize")
  expect(h.controller.getSnapshot().sideChats[a]?.maximized).toBe(true)
  h.controller.sideChat("reset")
  expect(h.controller.getSnapshot().sideChats[a]?.maximized).toBe(false)
  h.controller.sideChat("refresh"); await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces[side]?.composer.text).toBe("keep this draft")
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("parent draft")
  h.controller.sideChat("close"); await h.controller.settle()
  const resumed: string[] = []
  h.backend.resumeThread = async id => { resumed.push(id); return { summary: summary(id), events: [] } }
  h.controller.restart(); await h.controller.settle()
  expect(resumed).toEqual([a, side])
  expect(h.controller.getSnapshot().sideChats[a]?.visible).toBe(false)
  expect(h.controller.getSnapshot().workspaces[side]?.composer.text).toBe("keep this draft")
  await h.controller.close()
})

test("side quote appends selected text to parent draft without submitting", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.changeDraft("parent draft", 3)
  h.controller.sideChat("open"); await h.controller.settle()
  const side = threadId("side-1"), item = itemId("answer")
  h.emit({ type: "conversation", event: { type: "item.started", threadId: side, item: { id: item, turnId: turnId("answer-turn"), kind: "assistant", markdown: "Useful finding", status: "complete" } } })
  h.controller.transcript({ type: "cursor.move", target: { itemId: item, graphemeOffset: 0 }, preferredScreenRow: 0, extend: false })
  h.controller.transcript({ type: "selection.begin", shape: "character" })
  h.controller.transcript({ type: "cursor.move", target: { itemId: item, graphemeOffset: 5 }, preferredScreenRow: 0, extend: true })
  h.controller.executeCommand(":side quote"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(a)
  expect(h.controller.getSnapshot().workspaces[a]?.composer.text).toBe("parent draft\n\n> Useful")
  expect(h.controller.getSnapshot().workspaces[a]?.interaction.surface).toBe("composer")
  expect(h.starts).toEqual([])
  h.controller.executeCommand(":side focus side"); await h.controller.settle()
  expect(h.controller.getSnapshot().activeThreadId).toBe(side)
  expect(h.starts).toEqual([])
  await h.controller.close()
})

test("independent parents keep side forks isolated when creation completes out of order", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  let finishA!: (snapshot: SessionSnapshot) => void
  const defaultFork = h.backend.forkSideThread!
  h.backend.forkSideThread = id => id === a ? new Promise(resolve => { finishA = resolve }) : defaultFork(id)
  h.controller.sideChat("open", "A question")
  h.controller.openThread(b); await Promise.resolve()
  h.controller.sideChat("open", "B question")
  finishA({ summary: summary(threadId("side-a")), events: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.threadId).toBe(threadId("side-a"))
  expect(h.controller.getSnapshot().sideChats[b]?.threadId).toBe(threadId("side-1"))
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("side-1"))
  h.controller.sideChat("quit"); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.threadId).toBe(threadId("side-a"))
  expect(h.retired).toEqual(["side-1"])
  await h.controller.close()
})

test("late retirement of one side does not dispose another parent's presentation runtime", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  const sideA = threadId("side-1")
  h.controller.sideChat("close"); await h.controller.settle()
  h.controller.openThread(b); await h.controller.settle()
  h.controller.sideChat("open"); await h.controller.settle()
  const sideB = threadId("side-2")

  h.controller.openThread(a); await h.controller.settle()
  h.controller.sideChat("open"); await h.controller.settle()
  let finishRetirement: (() => void) | undefined
  h.backend.retireThread = id => id === sideA ? new Promise(resolve => { finishRetirement = resolve }) : Promise.resolve()
  h.controller.sideChat("quit")
  for (let attempt = 0; attempt < 10 && !finishRetirement; attempt++) await Promise.resolve()

  h.controller.openThread(b)
  h.controller.sideChat("open")
  const runtimeB = h.controller.transcriptRuntime("side")
  expect(runtimeB?.getThreadId()).toBe(sideB)
  expect(finishRetirement).toBeDefined()
  finishRetirement?.()
  await h.controller.settle()
  expect(h.controller.transcriptRuntime("side")).toBe(runtimeB)
  expect(runtimeB?.getThreadId()).toBe(sideB)
  await h.controller.close()
})

test("quit drains an in-flight goal update, suppresses queued goals, then clears before archive", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  const calls: string[] = []
  let finish!: () => void
  h.backend.getGoal = async () => null
  h.backend.setGoal = async (_id, update) => {
    calls.push(`set ${update.objective}`)
    await new Promise<void>(resolve => { finish = resolve })
    calls.push("set completed")
    return { objective: update.objective!, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 }
  }
  h.backend.clearGoal = async () => { calls.push("clear"); return true }
  h.backend.retireThread = async () => { calls.push("archive") }
  h.controller.executeNamedCommand("goal First objective")
  await Bun.sleep(0)
  expect(calls).toEqual(["set First objective"])
  h.controller.executeNamedCommand("goal Queued objective")
  h.controller.sideChat("quit")
  h.controller.executeNamedCommand("goal Forbidden objective")
  expect(calls).toEqual(["set First objective"])
  finish()
  await h.controller.settle()
  expect(calls).toEqual(["set First objective", "set completed", "clear", "archive"])
  expect(h.controller.getSnapshot().retiredSideThreadIds).toContain(threadId("side-1"))
  await h.controller.close()
})

test("quit drains in-flight approval and question responses and blocks further work", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  const side = threadId("side-1"), active = turnId("approved-turn")
  const calls: string[] = []
  let approve!: () => void, answer!: () => void
  h.backend.resolveApproval = async () => { calls.push("approve"); await new Promise<void>(resolve => { approve = resolve }); h.emit({ type: "conversation", event: { type: "turn.started", threadId: side, turnId: active } }) }
  h.backend.respondToQuestions = async () => { calls.push("answer"); await new Promise<void>(resolve => { answer = resolve }) }
  h.backend.clearGoal = async () => { calls.push("clear"); return true }
  h.backend.interruptTurn = async (_id, turn) => { calls.push(`interrupt ${turn}`) }
  h.backend.retireThread = async () => { calls.push("archive") }
  for (const id of ["approval", "later-approval"]) h.emit({ type: "approval", approval: { id, threadId: side, kind: "command", title: "Run", detail: "Command", choices: [{ id: "accept", label: "Accept" }], status: "pending" } })
  for (const id of ["question", "later-question"]) h.emit({ type: "question.requested", request: { id, threadId: side, turnId: active, questions: [{ id: "answer", header: "Question", question: "Value?", allowOther: true, secret: false }] } })
  h.controller.resolveApproval("approval", "accept")
  h.controller.answerQuestions("question", { answer: "value" })
  h.controller.sideChat("quit")
  h.controller.resolveApproval("later-approval", "accept")
  h.controller.answerQuestions("later-question", { answer: "value" })
  h.controller.changeDraft("preserve while quitting", 4)
  h.controller.submit("next-turn")
  h.controller.executeNamedCommand("compact")
  expect(h.controller.getSnapshot().workspaces[side]?.composer.text).toBe("preserve while quitting")
  expect(calls).toEqual(["approve", "answer"])
  approve(); answer()
  await h.controller.settle()
  expect(calls).toEqual(["approve", "answer", "clear", "interrupt approved-turn", "archive"])
  expect(h.starts).toEqual([])
  expect(h.controller.getSnapshot().approvals.order).toEqual([])
  expect(h.controller.getSnapshot().questions).toEqual({})
  await h.controller.close()
})

test("navigation to retained side reopens it only after successful focus", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open"); await h.controller.settle()
  h.controller.sideChat("close"); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.visible).toBe(false)
  h.controller.openThread(threadId("side-1")); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.visible).toBe(true)
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("side-1"))
  h.controller.sideChat("close"); await h.controller.settle()
  h.controller.openThread(a); await h.controller.settle()
  expect(h.controller.getSnapshot().sideChats[a]?.visible).toBe(false)
  await h.controller.close()
})

test("quitting cancels queued turns without consuming drafts and failed retirement allows explicit retry", async () => {
  const h = harness(); await h.controller.initialize("/tmp")
  h.controller.sideChat("open", "first turn"); await h.controller.settle()
  const side = threadId("side-1")
  h.controller.changeDraft("queued follow-up", 3); h.controller.submit("next-turn")
  let release!: () => void
  h.backend.clearGoal = async () => { await new Promise<void>(resolve => { release = resolve }); return false }
  h.backend.retireThread = async () => { throw new Error("archive failed") }
  h.controller.sideChat("quit")
  await Bun.sleep(0)
  h.emit({ type: "conversation", event: { type: "turn.completed", threadId: side, turnId: turnId("turn-1"), outcome: "complete" } })
  release()
  await h.controller.settle()
  expect(h.starts).toEqual(["first turn"])
  const queued = h.controller.getSnapshot().workspaces[side]?.composer.outbox.find(message => message.text === "queued follow-up")
  expect(queued?.status).toBe("failed")
  expect(h.controller.getSnapshot().sideChats[a]?.status).toBeUndefined()
  h.controller.retryOutgoing(queued!.id); await h.controller.settle()
  expect(h.starts).toEqual(["first turn", "queued follow-up"])
  await h.controller.close()
})

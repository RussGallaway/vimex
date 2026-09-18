import { describe, expect, test } from "bun:test"
import { itemId, threadId, turnId, type ThreadSummary } from "@vimex/conversation"
import { activeWorkspace, initialWorkbench, transitionWorkbench, type WorkbenchState } from "./index"

const summary = (id: string): ThreadSummary => ({ id: threadId(id), title: id, model: "gpt", reasoningEffort: "high", cwd: "/tmp", status: "idle" })
const run = (state: WorkbenchState, command: Parameters<typeof transitionWorkbench>[1]) => transitionWorkbench(state, command)

describe("workbench", () => {
  test("registers background threads without changing the active thread", () => {
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("active") }).state
    state = run(state, { type: "thread.register", summary: summary("background") }).state
    expect(state.activeThreadId).toBe(threadId("active"))
    expect(state.workspaces[threadId("background")]).toBeDefined()
    state = run(state, { type: "thread.register", summary: { ...summary("background"), title: "renamed" } }).state
    expect(state.threadOrder.filter((id) => id === threadId("background"))).toHaveLength(1)
    expect(state.summaries[threadId("background")]?.title).toBe("renamed")
  })

  test("preserves drafts, anchors, folds, and modes per thread", () => {
    const threadA = threadId("a"), turnA = turnId("ta"), itemA = itemId("ia")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "conversation.event", event: { type: "item.started", threadId: threadA, item: { id: itemA, turnId: turnA, kind: "assistant", markdown: "alpha output", status: "complete" } } }).state
    state = run(state, { type: "transcript.command", command: { type: "cursor.move", point: { itemId: itemA, graphemeOffset: 2 }, preferredScreenRow: 5 } }).state
    state = run(state, { type: "transcript.command", command: { type: "fold.set", itemId: itemA, folded: true } }).state
    state = run(state, { type: "composer.change", text: "alpha" }).state
    state = run(state, { type: "interaction.command", command: { type: "mode.insert" } }).state
    state = run(state, { type: "thread.open", summary: summary("b") }).state
    state = run(state, { type: "composer.change", text: "beta" }).state
    state = run(state, { type: "thread.switch", threadId: threadId("a") }).state
    expect(activeWorkspace(state)?.composer.text).toBe("alpha")
    expect(activeWorkspace(state)?.interaction.mode).toBe("insert")
    expect(activeWorkspace(state)?.transcript.folded[itemA]).toBe(true)
    expect(activeWorkspace(state)?.transcript.viewport).toEqual({ kind: "point", point: { itemId: itemA, graphemeOffset: 2 }, preferredScreenRow: 5 })
    state = run(state, { type: "thread.switch", threadId: threadId("b") }).state
    expect(activeWorkspace(state)?.composer.text).toBe("beta")
  })

  test("fold mutations request restoration of the stable semantic anchor", () => {
    const thread = threadId("a"), item = itemId("i")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "conversation.event", event: { type: "item.started", threadId: thread, item: { id: item, turnId: turnId("t"), kind: "tool", title: "tool", detail: "output", status: "complete" } } }).state
    state = run(state, { type: "transcript.command", command: { type: "cursor.move", point: { itemId: item, graphemeOffset: 1 }, preferredScreenRow: 4 } }).state
    const anchor = activeWorkspace(state)!.transcript.viewport
    const result = run(state, { type: "transcript.command", command: { type: "fold.toggle", itemId: item } })
    expect(result.effects).toEqual([{ type: "viewport.restore", threadId: thread, anchor }])
    expect(activeWorkspace(result.state)?.transcript.viewport).toEqual(anchor)
  })

  test("streams without moving pinned views and drains one queued message once", () => {
    const thread = threadId("a"), firstTurn = turnId("t1"), firstItem = itemId("i1")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "conversation.event", event: { type: "turn.started", threadId: thread, turnId: firstTurn } }).state
    state = run(state, { type: "conversation.event", event: { type: "item.started", threadId: thread, item: { id: firstItem, turnId: firstTurn, kind: "assistant", markdown: "a", status: "running" } } }).state
    state = run(state, { type: "transcript.command", command: { type: "cursor.move", point: { itemId: firstItem, graphemeOffset: 0 }, preferredScreenRow: 6 } }).state
    const anchor = activeWorkspace(state)!.transcript.viewport
    state = run(state, { type: "composer.change", text: "next" }).state
    let result = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "m1" })
    expect(result.effects).toEqual([])
    state = result.state
    state = run(state, { type: "conversation.event", event: { type: "item.delta", threadId: thread, itemId: firstItem, delta: "bc" } }).state
    expect(activeWorkspace(state)?.transcript.viewport).toEqual(anchor)
    result = run(state, { type: "conversation.event", event: { type: "turn.completed", threadId: thread, turnId: firstTurn, outcome: "complete" } })
    expect(result.effects).toEqual([{ type: "conversation.turn.start", threadId: thread, text: "next", clientMessageId: "m1" }])
    const duplicate = run(result.state, { type: "conversation.event", event: { type: "turn.completed", threadId: thread, turnId: firstTurn, outcome: "complete" } })
    expect(duplicate.effects).toEqual([])
  })

  test("steers immediately and approvals never steal composer focus", () => {
    const thread = threadId("a")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "conversation.event", event: { type: "turn.started", threadId: thread, turnId: turnId("active") } }).state
    state = run(state, { type: "interaction.command", command: { type: "mode.insert" } }).state
    state = run(state, { type: "composer.change", text: "redirect" }).state
    let result = run(state, { type: "composer.submit", intent: "steer", clientMessageId: "s1" })
    expect(result.effects[0]?.type).toBe("conversation.turn.steer")
    state = result.state
    const interaction = activeWorkspace(state)!.interaction
    result = run(state, { type: "approval.received", approval: { id: "ap", threadId: thread, kind: "command", title: "Run", detail: "x", choices: [{ id: "yes", label: "Yes" }], status: "pending" } })
    expect(activeWorkspace(result.state)?.interaction).toEqual(interaction)
    expect(run(result.state, { type: "approval.resolve", approvalId: "ap", choiceId: "yes" }).effects[0]?.type).toBe("approval.resolve")
  })

  test("serializes next-turn submissions during the turn-start race and starts an idle steer", () => {
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "composer.change", text: "first" }).state
    let result = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "one" })
    expect(result.effects).toHaveLength(1)
    state = run(result.state, { type: "composer.change", text: "second" }).state
    result = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "two" })
    expect(result.effects).toEqual([])
    expect(activeWorkspace(result.state)?.composer.outbox.find((message) => message.id === "two")?.status).toBe("queued")
    const duplicate = run(result.state, { type: "composer.submit", intent: "next-turn", clientMessageId: "two" })
    expect(duplicate.effects).toEqual([])
    state = run(initialWorkbench(), { type: "thread.open", summary: summary("idle") }).state
    state = run(state, { type: "composer.change", text: "start instead" }).state
    result = run(state, { type: "composer.submit", intent: "steer", clientMessageId: "steer-idle" })
    expect(result.effects[0]?.type).toBe("conversation.turn.start")
  })

  test("queues steering until the starting turn id is known", () => {
    const thread = threadId("a"), turn = turnId("started")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "composer.change", text: "first" }).state
    state = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "first" }).state
    state = run(state, { type: "composer.change", text: "redirect" }).state
    let result = run(state, { type: "composer.submit", intent: "steer", clientMessageId: "steer" })
    expect(result.effects).toEqual([])
    expect(activeWorkspace(result.state)?.composer.outbox.find((message) => message.id === "steer")?.status).toBe("queued")
    result = run(result.state, { type: "conversation.event", event: { type: "turn.started", threadId: thread, turnId: turn } })
    expect(result.effects).toEqual([{ type: "conversation.turn.steer", threadId: thread, text: "redirect", clientMessageId: "steer" }])
    const duplicate = run(result.state, { type: "conversation.event", event: { type: "turn.started", threadId: thread, turnId: turn } })
    expect(duplicate.effects).toEqual([])
  })

  test("promotes the next queued turn after a start failure and retries failed outgoing messages", () => {
    const thread = threadId("a")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "composer.change", text: "first" }).state
    state = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "first" }).state
    state = run(state, { type: "composer.change", text: "second" }).state
    state = run(state, { type: "composer.submit", intent: "next-turn", clientMessageId: "second" }).state
    let result = run(state, { type: "composer.fail", threadId: thread, clientMessageId: "first", reason: "offline" })
    expect(activeWorkspace(result.state)?.composer.outbox.find((message) => message.id === "first")).toMatchObject({ status: "failed", reason: "offline" })
    expect(result.effects).toEqual([{ type: "conversation.turn.start", threadId: thread, text: "second", clientMessageId: "second" }])
    result = run(result.state, { type: "composer.retry", clientMessageId: "first" })
    expect(result.effects).toEqual([])
    expect(activeWorkspace(result.state)?.composer.outbox.find((message) => message.id === "first")?.status).toBe("queued")
  })

  test("retries failed approval resolution", () => {
    const thread = threadId("a")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "approval.received", approval: { id: "ap", threadId: thread, kind: "command", title: "Run", detail: "x", choices: [{ id: "yes", label: "Yes" }], status: "pending" } }).state
    state = run(state, { type: "approval.resolve", approvalId: "ap", choiceId: "yes" }).state
    state = run(state, { type: "approval.failed", approvalId: "ap", error: "offline" }).state
    const result = run(state, { type: "approval.resolve", approvalId: "ap", choiceId: "yes" })
    expect(result.state.approvals.byId.ap).toMatchObject({ status: "resolving", error: undefined })
    expect(result.effects).toEqual([{ type: "approval.resolve", approvalId: "ap", choiceId: "yes" }])
  })

  test("forks completed history into independent state", () => {
    const source = threadId("a"), turn = turnId("t"), item = itemId("i")
    let state = run(initialWorkbench(), { type: "thread.open", summary: summary("a") }).state
    state = run(state, { type: "conversation.event", event: { type: "turn.started", threadId: source, turnId: turn } }).state
    state = run(state, { type: "conversation.event", event: { type: "item.started", threadId: source, item: { id: item, turnId: turn, kind: "assistant", markdown: "done", status: "complete" } } }).state
    state = run(state, { type: "conversation.event", event: { type: "turn.completed", threadId: source, turnId: turn, outcome: "complete" } }).state
    state = run(state, { type: "thread.fork.completed", sourceThreadId: source, throughTurnId: turn, summary: summary("child") }).state
    state = run(state, { type: "composer.change", text: "child draft" }).state
    expect(state.workspaces[source]?.composer.text).toBe("")
    expect(state.workspaces[threadId("child")]?.composer.text).toBe("child draft")
    expect(state.workspaces[threadId("child")]?.conversation).not.toBe(state.workspaces[source]?.conversation)
  })

  test("projects questions and unique agent relationships", () => {
    const thread = threadId("a"), turn = turnId("turn"), child = threadId("child"), item = itemId("agent")
    let state = run(initialWorkbench(), { type: "question.received", request: {
      id: "question", threadId: thread, turnId: turn,
      questions: [{ id: "choice", header: "Choose", question: "Which?", allowOther: false, secret: false }],
    } }).state
    expect(state.questions.question?.questions[0]?.header).toBe("Choose")
    const link = { parentId: thread, childId: child, itemId: item, relation: "spawned" as const }
    state = run(state, { type: "agent.link", link }).state
    state = run(state, { type: "agent.link", link }).state
    expect(state.agentRelationships).toEqual([link])
    state = run(state, { type: "question.resolved", id: "question" }).state
    expect(state.questions).toEqual({})
  })
})

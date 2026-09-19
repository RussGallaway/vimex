import { describe, expect, test } from "bun:test"
import { createConversation, effectiveItemStatus, forkConversation, itemId, reduceConversation, threadId, turnId } from "./index"

describe("conversation", () => {
  test("duplicate running turn starts preserve state identity", () => {
    const thread = threadId("identity"), turn = turnId("turn")
    const started = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: turn, startedAt: 1_000 })
    expect(reduceConversation(started, { type: "turn.started", threadId: thread, turnId: turn, startedAt: 2_000 })).toBe(started)
  })

  test("a stale start enriches its turn without replacing the newer active turn", () => {
    const thread = threadId("ordered"), older = turnId("older"), newer = turnId("newer")
    let state = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: older })
    state = reduceConversation(state, { type: "turn.started", threadId: thread, turnId: newer, startedAt: 2_000 })
    state = reduceConversation(state, { type: "turn.started", threadId: thread, turnId: older, startedAt: 1_000 })
    expect(state.activeTurnId).toBe(newer)
    expect(state.turns[older]?.startedAt).toBe(1_000)
  })

  test("preserves observed turn timing and enriches terminal replay without regressing status", () => {
    const thread = threadId("timing"), turn = turnId("turn")
    let state = reduceConversation(createConversation(thread), { type: "turn.completed", threadId: thread, turnId: turn, outcome: "complete" })
    state = reduceConversation(state, { type: "turn.started", threadId: thread, turnId: turn, startedAt: 1_000 })
    state = reduceConversation(state, { type: "turn.completed", threadId: thread, turnId: turn, outcome: "failed", startedAt: 900, completedAt: 3_500, durationMs: 2_500 })
    expect(state.turns[turn]).toEqual({ id: turn, status: "complete", itemIds: [], startedAt: 1_000, completedAt: 3_500, durationMs: 2_500 })
    expect(state.activeTurnId).toBeUndefined()
  })

  test("streams deltas without duplicating items and forks through a completed turn", () => {
    const source = threadId("source"), turn = turnId("turn-1"), item = itemId("item-1")
    let state = reduceConversation(createConversation(source), { type: "turn.started", threadId: source, turnId: turn })
    state = reduceConversation(state, { type: "item.started", threadId: source, item: { id: item, turnId: turn, kind: "assistant", markdown: "hi", status: "running" } })
    state = reduceConversation(state, { type: "item.delta", threadId: source, itemId: item, delta: " there" })
    state = reduceConversation(state, { type: "item.started", threadId: source, item: state.items[item]! })
    expect(state.turns[turn]?.itemIds).toEqual([item])
    expect(state.items[item]).toMatchObject({ markdown: "hi there" })
    expect(forkConversation(state, threadId("child"), turn)).toBeUndefined()
    state = reduceConversation(state, { type: "turn.completed", threadId: source, turnId: turn, outcome: "complete" })
    const fork = forkConversation(state, threadId("child"), turn)!
    expect(fork.threadId).toBe(threadId("child"))
    expect(fork.items[item]).not.toBe(state.items[item])
  })

  test("upserts terminal replay events and never regresses terminal state", () => {
    const thread = threadId("replay"), turn = turnId("turn"), item = itemId("item")
    const completeItem = { id: item, turnId: turn, kind: "assistant" as const, markdown: "latest", status: "complete" as const }
    let state = reduceConversation(createConversation(thread), { type: "item.completed", threadId: thread, item: completeItem })
    state = reduceConversation(state, { type: "turn.completed", threadId: thread, turnId: turn, outcome: "complete" })
    expect(state.turnIds).toEqual([turn])
    expect(state.turns[turn]?.itemIds).toEqual([item])
    expect(state.items[item]).toEqual(completeItem)

    state = reduceConversation(state, { type: "turn.started", threadId: thread, turnId: turn })
    state = reduceConversation(state, { type: "item.started", threadId: thread, item: { ...completeItem, markdown: "stale", status: "running" } })
    state = reduceConversation(state, { type: "item.delta", threadId: thread, itemId: item, delta: " stale" })
    state = reduceConversation(state, { type: "item.completed", threadId: thread, item: { ...completeItem, markdown: "older" } })
    expect(state.activeTurnId).toBeUndefined()
    expect(state.turns[turn]?.status).toBe("complete")
    expect(state.items[item]).toEqual(completeItem)
    expect(state.turnIds).toEqual([turn])
    expect(state.turns[turn]?.itemIds).toEqual([item])
  })

  test("turn completion settles presentation while preserving a late authoritative item payload", () => {
    const thread = threadId("interrupt"), turn = turnId("turn"), item = itemId("reasoning")
    let state = reduceConversation(createConversation(thread), { type: "turn.started", threadId: thread, turnId: turn })
    state = reduceConversation(state, { type: "item.started", threadId: thread, item: { id: item, turnId: turn, kind: "reasoning", markdown: "partial", status: "running" } })
    state = reduceConversation(state, { type: "turn.completed", threadId: thread, turnId: turn, outcome: "interrupted" })
    expect(state.activeTurnId).toBeUndefined()
    expect(state.items[item]?.status).toBe("running")
    expect(effectiveItemStatus(state, state.items[item]!)).toBe("interrupted")

    state = reduceConversation(state, { type: "item.completed", threadId: thread, item: { id: item, turnId: turn, kind: "reasoning", markdown: "authoritative final text", status: "interrupted" } })
    expect(state.items[item]).toMatchObject({ markdown: "authoritative final text", status: "interrupted" })

    const late = itemId("late")
    state = reduceConversation(state, { type: "item.started", threadId: thread, item: { id: late, turnId: turn, kind: "reasoning", markdown: "late", status: "running" } })
    expect(effectiveItemStatus(state, state.items[late]!)).toBe("interrupted")
  })
})

for (const [outcome, expected] of [["complete", "complete"], ["failed", "error"], ["interrupted", "interrupted"]] as const) {
  test(`effective item status settles ${outcome} turns without overriding completed items`, () => {
    const thread = threadId("status"), turn = turnId("turn"), id = itemId("item")
    const state = reduceConversation(createConversation(thread), { type: "turn.completed", threadId: thread, turnId: turn, outcome })
    const item = { id, turnId: turn, kind: "assistant" as const, markdown: "Final text", status: "running" as const }
    expect(effectiveItemStatus(state, item)).toBe(expected)
    expect(effectiveItemStatus(state, { ...item, status: "complete" })).toBe("complete")
    expect(item.status).toBe("running")
  })
}

import { describe, expect, test } from "bun:test"
import { createConversation, forkConversation, itemId, reduceConversation, threadId, turnId } from "./index"

describe("conversation", () => {
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
})

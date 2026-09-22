import { describe, expect, test } from "bun:test"
import {
  appendConversationTurnId,
  appendTurnItemId,
  createConversationReductionDiagnostics,
  createConversationStructureDiagnostics,
  forkConversation,
  isConversationItemAddition,
  isConversationTurnIdAppend,
  isConversationTurnAdditionThenItemAppend,
  isConversationTurnUpdate,
  isTurnItemIdAppend,
  itemId,
  persistentConversationItems,
  persistentConversationTurnIds,
  persistentConversationTurns,
  persistentTurnItemIds,
  reduceConversationReference,
  reduceConversationWithDiagnostics,
  setConversationTurn,
  threadId,
  turnId,
  turnItemIdsHave,
  type ConversationItemRecordDiagnostics,
  type ConversationState,
  type ConversationStructureDiagnostics,
  type Turn,
} from "./index"

function reducerDiagnostics(): ConversationItemRecordDiagnostics &
  ConversationStructureDiagnostics {
  return createConversationReductionDiagnostics()
}

function structuralFixture(count: number): ConversationState {
  const ids = new Array(count)
  const turns = Object.create(null) as Record<string, Turn>
  const emptyItemIds = persistentTurnItemIds()
  for (let index = 0; index < count; index++) {
    const id = turnId(`turn-${String(index).padStart(6, "0")}`)
    ids[index] = id
    turns[id] = { id, status: "complete", itemIds: emptyItemIds }
  }
  return {
    threadId: threadId(`scale-${count}`),
    turnIds: persistentConversationTurnIds(ids),
    turns: persistentConversationTurns(turns),
    items: persistentConversationItems(),
  }
}

describe("persistent canonical conversation structure", () => {
  test("retains array and record reflection, JSON, special ids, and immutable snapshots", () => {
    const diagnostics = createConversationStructureDiagnostics()
    const originalTurnIds = persistentConversationTurnIds(
      [
        turnId("named-first"),
        turnId("10"),
        turnId("2"),
        turnId("__proto__"),
        turnId("constructor"),
        turnId("toString"),
      ],
      diagnostics,
    )
    const turnIds = appendConversationTurnId(
      originalTurnIds,
      turnId("named-last"),
      diagnostics,
    )
    const originalItemIds = persistentTurnItemIds(
      [itemId("__proto__"), itemId("constructor")],
      diagnostics,
    )
    const itemIds = appendTurnItemId(
      originalItemIds,
      itemId("toString"),
      diagnostics,
    )
    let turns = persistentConversationTurns()
    for (const id of turnIds)
      turns = setConversationTurn(
        turns,
        { id, status: "complete", itemIds },
        diagnostics,
      )

    expect(Array.isArray(turnIds)).toBe(true)
    expect(turnIds.map(String)).toEqual([
      "named-first",
      "10",
      "2",
      "__proto__",
      "constructor",
      "toString",
      "named-last",
    ])
    expect([...turnIds]).toEqual(turnIds.slice())
    expect(turnIds.map(String)).toEqual([...turnIds])
    expect(turnIds.indexOf(turnId("__proto__"))).toBe(3)
    expect(Object.keys(turnIds)).toEqual(["0", "1", "2", "3", "4", "5", "6"])
    expect(Object.getOwnPropertyDescriptor(turnIds, "0")).toMatchObject({
      enumerable: true,
      writable: false,
    })
    expect(JSON.parse(JSON.stringify(turnIds))).toEqual([...turnIds])
    expect(Reflect.set(turnIds, "0", turnId("changed"))).toBe(false)
    expect(Reflect.deleteProperty(turnIds, "0")).toBe(false)
    expect(
      Reflect.defineProperty(turnIds, "7", { value: turnId("extra") }),
    ).toBe(false)
    expect(Reflect.setPrototypeOf(turnIds, {})).toBe(false)
    expect(Reflect.preventExtensions(turnIds)).toBe(false)
    expect(() => Object.freeze(turnIds)).toThrow(TypeError)

    expect(itemIds.map(String)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ])
    expect(turnItemIdsHave(itemIds, itemId("constructor"))).toBe(true)
    expect(turnItemIdsHave(itemIds, itemId("missing"))).toBe(false)
    expect(originalItemIds.map(String)).toEqual(["__proto__", "constructor"])
    expect(Object.keys(turns)).toEqual([
      "2",
      "10",
      "named-first",
      "__proto__",
      "constructor",
      "toString",
      "named-last",
    ])
    expect(Object.keys(JSON.parse(JSON.stringify(turns)))).toEqual(
      Object.keys(turns),
    )
    expect(Object.hasOwn(turns, "__proto__")).toBe(true)
    expect(turns["__proto__"]?.id).toBe(turnId("__proto__"))
    expect(({ ...turns } as Record<string, Turn>)["constructor"]).toBe(
      turns["constructor"],
    )
    expect(Reflect.set(turns, "extra", turns["2"]!)).toBe(false)
    expect(Reflect.deleteProperty(turns, "2")).toBe(false)
    expect(Reflect.defineProperty(turns, "extra", { value: turns["2"] })).toBe(
      false,
    )
    expect(Reflect.setPrototypeOf(turns, {})).toBe(false)
    expect(Reflect.preventExtensions(turns)).toBe(false)
    expect(() => Object.freeze(turns)).toThrow(TypeError)

    expect(originalTurnIds.map(String)).toEqual([
      "named-first",
      "10",
      "2",
      "__proto__",
      "constructor",
      "toString",
    ])
    expect(Object.keys(turns)).not.toContain("extra")
    expect(diagnostics.conversationTurnIdSequenceAppends).toBe(1)
    expect(diagnostics.conversationTurnItemIdSequenceAppends).toBe(1)
    expect(diagnostics.conversationTurnRecordUpdates).toBe(turnIds.length)
  })

  for (const count of [100, 1_000, 10_000, 100_000]) {
    test(`admits one tail turn and item with logarithmic path copying at ${count.toLocaleString()} turns`, () => {
      const before = structuralFixture(count)
      const first = before.turns[before.turnIds[0]!]!
      const middle = before.turns[before.turnIds[Math.floor(count / 2)]!]!
      const last = before.turns[before.turnIds[count - 1]!]!
      const nextTurnId = turnId("__proto__")
      const nextItemId = itemId("constructor")
      const turnEvent = {
        type: "turn.started" as const,
        threadId: before.threadId,
        turnId: nextTurnId,
      }
      const itemEvent = {
        type: "item.started" as const,
        threadId: before.threadId,
        item: {
          id: nextItemId,
          turnId: nextTurnId,
          kind: "assistant" as const,
          markdown: "tail",
          status: "running" as const,
        },
      }
      const diagnostics = reducerDiagnostics()
      const withTurn = reduceConversationWithDiagnostics(
        before,
        turnEvent,
        diagnostics,
      )
      const after = reduceConversationWithDiagnostics(
        withTurn,
        itemEvent,
        diagnostics,
      )
      const referenceWithTurn = reduceConversationReference(before, turnEvent)
      const reference = reduceConversationReference(
        referenceWithTurn,
        itemEvent,
      )
      const logarithmicBound = Math.ceil(Math.log2(count + 2)) + 3

      expect(after).toEqual(reference)
      expect(JSON.parse(JSON.stringify(after))).toEqual(
        JSON.parse(JSON.stringify(reference)),
      )
      expect(after.turnIds).not.toBe(before.turnIds)
      expect(after.turns).not.toBe(before.turns)
      expect(after.turnIds.length).toBe(count + 1)
      expect(after.turnIds.at(-1)).toBe(nextTurnId)
      expect(after.turns[nextTurnId]?.itemIds).toEqual([nextItemId])
      expect(after.items[nextItemId]).toBe(itemEvent.item)
      const emptyTurn = withTurn.turns[nextTurnId]!
      const nextTurn = after.turns[nextTurnId]!
      expect(
        isConversationTurnIdAppend(before.turnIds, after.turnIds, nextTurnId),
      ).toBe(true)
      expect(
        isConversationTurnUpdate(
          before.turns,
          withTurn.turns,
          nextTurnId,
          undefined,
          emptyTurn,
        ),
      ).toBe(true)
      expect(
        isConversationTurnUpdate(
          withTurn.turns,
          after.turns,
          nextTurnId,
          emptyTurn,
          nextTurn,
        ),
      ).toBe(true)
      expect(
        isConversationTurnAdditionThenItemAppend(
          before.turns,
          after.turns,
          nextTurnId,
          nextItemId,
          nextTurn,
        ),
      ).toBe(true)
      expect(
        isTurnItemIdAppend(emptyTurn.itemIds, nextTurn.itemIds, nextItemId),
      ).toBe(true)
      expect(
        isConversationItemAddition(before.items, after.items, itemEvent.item),
      ).toBe(true)
      expect(
        isConversationTurnIdAppend(
          before.turnIds,
          persistentConversationTurnIds([...after.turnIds]),
          nextTurnId,
        ),
      ).toBe(false)
      expect(after.turns[before.turnIds[0]!]).toBe(first)
      expect(after.turns[before.turnIds[Math.floor(count / 2)]!]).toBe(middle)
      expect(after.turns[before.turnIds[count - 1]!]).toBe(last)
      expect(before.turnIds.length).toBe(count)
      expect(before.turnIds.includes(nextTurnId)).toBe(false)
      expect(Object.hasOwn(before.turns, nextTurnId)).toBe(false)
      expect(Object.hasOwn(before.items, nextItemId)).toBe(false)

      expect(diagnostics.conversationTurnIdSequenceNormalizations).toBe(0)
      expect(diagnostics.conversationTurnIdSequenceNormalizationVisits).toBe(0)
      expect(diagnostics.conversationTurnIdSequenceAppends).toBe(1)
      expect(
        diagnostics.conversationTurnIdSequenceNodeVisits,
      ).toBeLessThanOrEqual(2 * logarithmicBound)
      expect(
        diagnostics.conversationTurnIdSequenceNodesCopied,
      ).toBeLessThanOrEqual(6 * logarithmicBound)
      expect(diagnostics.conversationTurnItemIdSequenceNormalizations).toBe(0)
      expect(
        diagnostics.conversationTurnItemIdSequenceNormalizationVisits,
      ).toBe(0)
      expect(diagnostics.conversationTurnItemIdSequenceAppends).toBe(1)
      expect(diagnostics.conversationTurnItemIdSequenceLookups).toBe(1)
      expect(diagnostics.conversationTurnItemIdSequenceLookupNodeVisits).toBe(0)
      expect(diagnostics.conversationTurnItemIdSequenceNodeVisits).toBe(2)
      expect(diagnostics.conversationTurnItemIdSequenceNodesCopied).toBe(2)
      expect(diagnostics.conversationTurnRecordNormalizations).toBe(0)
      expect(diagnostics.conversationTurnRecordNormalizationVisits).toBe(0)
      expect(diagnostics.conversationTurnRecordLookups).toBe(2)
      expect(
        diagnostics.conversationTurnRecordLookupNodeVisits,
      ).toBeLessThanOrEqual(4 * logarithmicBound)
      expect(diagnostics.conversationTurnRecordUpdates).toBe(2)
      expect(diagnostics.conversationTurnRecordNodeVisits).toBeLessThanOrEqual(
        4 * logarithmicBound,
      )
      expect(diagnostics.conversationTurnRecordNodesCopied).toBeLessThanOrEqual(
        12 * logarithmicBound,
      )
      expect(diagnostics.conversationItemRecordNormalizations).toBe(0)
      expect(diagnostics.conversationItemRecordNormalizationItemVisits).toBe(0)

      expect(Object.isFrozen(reference.turnIds)).toBe(true)
      expect(Object.isFrozen(reference.turns)).toBe(true)
      expect(Object.isFrozen(reference.turns[nextTurnId]?.itemIds)).toBe(true)
      expect(Object.isFrozen(reference.items)).toBe(true)
      expect(Object.isFrozen(after.turnIds)).toBe(false)
      expect(Object.isFrozen(after.turns)).toBe(false)
    }, 30_000)
  }

  test("normalizes fork structure without aliasing semantic values", () => {
    const source = structuralFixture(3)
    const boundary = source.turnIds[2]!
    const completed = reduceConversationWithDiagnostics(
      source,
      {
        type: "item.completed",
        threadId: source.threadId,
        item: {
          id: itemId("fork-item"),
          turnId: boundary,
          kind: "assistant",
          markdown: "done",
          status: "complete",
        },
      },
      reducerDiagnostics(),
    )
    const fork = forkConversation(completed, threadId("fork-child"), boundary)!

    expect(fork).toEqual({ ...completed, threadId: threadId("fork-child") })
    expect(fork.turnIds).not.toBe(completed.turnIds)
    expect(fork.turns).not.toBe(completed.turns)
    expect(fork.turns[boundary]).not.toBe(completed.turns[boundary])
    expect(fork.turns[boundary]?.itemIds).not.toBe(
      completed.turns[boundary]?.itemIds,
    )
    expect(fork.items[itemId("fork-item")]).not.toBe(
      completed.items[itemId("fork-item")],
    )
    expect(Reflect.set(fork.turnIds, "0", turnId("changed"))).toBe(false)
    expect(Reflect.set(fork.turns, "changed", fork.turns[boundary]!)).toBe(
      false,
    )
  })
})

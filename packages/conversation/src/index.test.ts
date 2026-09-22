import { describe, expect, test } from "bun:test"
import {
  conversationItemAt,
  createConversation,
  effectiveItemStatus,
  forkConversation,
  itemId,
  persistentConversationItems,
  reduceConversation,
  reduceConversationReference,
  reduceConversationWithDiagnostics,
  setConversationItem,
  threadId,
  turnId,
  type ConversationItem,
  type ConversationItemRecordDiagnostics,
} from "./index"

function itemDiagnostics(): ConversationItemRecordDiagnostics {
  return {
    conversationItemRecordNormalizations: 0,
    conversationItemRecordNormalizationItemVisits: 0,
    conversationItemRecordLookups: 0,
    conversationItemRecordLookupNodeVisits: 0,
    conversationItemRecordUpdates: 0,
    conversationItemRecordNodeVisits: 0,
    conversationItemRecordNodesCopied: 0,
  }
}

function runningItem(id: string): ConversationItem {
  return {
    id: itemId(id),
    turnId: turnId("record-turn"),
    kind: "assistant",
    markdown: `value:${id}`,
    status: "running",
  }
}

describe("conversation", () => {
  test("duplicate running turn starts preserve state identity", () => {
    const thread = threadId("identity"),
      turn = turnId("turn")
    const started = reduceConversation(createConversation(thread), {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 1_000,
    })
    expect(
      reduceConversation(started, {
        type: "turn.started",
        threadId: thread,
        turnId: turn,
        startedAt: 2_000,
      }),
    ).toBe(started)
  })

  test("a stale start enriches its turn without replacing the newer active turn", () => {
    const thread = threadId("ordered"),
      older = turnId("older"),
      newer = turnId("newer")
    let state = reduceConversation(createConversation(thread), {
      type: "turn.started",
      threadId: thread,
      turnId: older,
    })
    state = reduceConversation(state, {
      type: "turn.started",
      threadId: thread,
      turnId: newer,
      startedAt: 2_000,
    })
    state = reduceConversation(state, {
      type: "turn.started",
      threadId: thread,
      turnId: older,
      startedAt: 1_000,
    })
    expect(state.activeTurnId).toBe(newer)
    expect(state.turns[older]?.startedAt).toBe(1_000)
  })

  test("preserves observed turn timing and enriches terminal replay without regressing status", () => {
    const thread = threadId("timing"),
      turn = turnId("turn")
    let state = reduceConversation(createConversation(thread), {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    })
    state = reduceConversation(state, {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
      startedAt: 1_000,
    })
    state = reduceConversation(state, {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "failed",
      startedAt: 900,
      completedAt: 3_500,
      durationMs: 2_500,
    })
    expect(state.turns[turn]).toEqual({
      id: turn,
      status: "complete",
      itemIds: [],
      startedAt: 1_000,
      completedAt: 3_500,
      durationMs: 2_500,
    })
    expect(state.activeTurnId).toBeUndefined()
  })

  test("streams deltas without duplicating items and forks through a completed turn", () => {
    const source = threadId("source"),
      turn = turnId("turn-1"),
      item = itemId("item-1")
    let state = reduceConversation(createConversation(source), {
      type: "turn.started",
      threadId: source,
      turnId: turn,
    })
    state = reduceConversation(state, {
      type: "item.started",
      threadId: source,
      item: {
        id: item,
        turnId: turn,
        kind: "assistant",
        markdown: "hi",
        status: "running",
      },
    })
    state = reduceConversation(state, {
      type: "item.delta",
      threadId: source,
      itemId: item,
      delta: " there",
    })
    state = reduceConversation(state, {
      type: "item.started",
      threadId: source,
      item: state.items[item]!,
    })
    expect(state.turns[turn]?.itemIds).toEqual([item])
    expect(state.items[item]).toMatchObject({ markdown: "hi there" })
    expect(forkConversation(state, threadId("child"), turn)).toBeUndefined()
    state = reduceConversation(state, {
      type: "turn.completed",
      threadId: source,
      turnId: turn,
      outcome: "complete",
    })
    const fork = forkConversation(state, threadId("child"), turn)!
    expect(fork.threadId).toBe(threadId("child"))
    expect(fork.items[item]).not.toBe(state.items[item])
  })

  test("upserts terminal replay events and never regresses terminal state", () => {
    const thread = threadId("replay"),
      turn = turnId("turn"),
      item = itemId("item")
    const completeItem = {
      id: item,
      turnId: turn,
      kind: "assistant" as const,
      markdown: "latest",
      status: "complete" as const,
    }
    let state = reduceConversation(createConversation(thread), {
      type: "item.completed",
      threadId: thread,
      item: completeItem,
    })
    state = reduceConversation(state, {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    })
    expect(state.turnIds).toEqual([turn])
    expect(state.turns[turn]?.itemIds).toEqual([item])
    expect(state.items[item]).toEqual(completeItem)

    state = reduceConversation(state, {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
    })
    state = reduceConversation(state, {
      type: "item.started",
      threadId: thread,
      item: { ...completeItem, markdown: "stale", status: "running" },
    })
    state = reduceConversation(state, {
      type: "item.delta",
      threadId: thread,
      itemId: item,
      delta: " stale",
    })
    state = reduceConversation(state, {
      type: "item.completed",
      threadId: thread,
      item: { ...completeItem, markdown: "older" },
    })
    expect(state.activeTurnId).toBeUndefined()
    expect(state.turns[turn]?.status).toBe("complete")
    expect(state.items[item]).toEqual(completeItem)
    expect(state.turnIds).toEqual([turn])
    expect(state.turns[turn]?.itemIds).toEqual([item])
  })

  test("turn completion settles presentation while preserving a late authoritative item payload", () => {
    const thread = threadId("interrupt"),
      turn = turnId("turn"),
      item = itemId("reasoning")
    let state = reduceConversation(createConversation(thread), {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
    })
    state = reduceConversation(state, {
      type: "item.started",
      threadId: thread,
      item: {
        id: item,
        turnId: turn,
        kind: "reasoning",
        markdown: "partial",
        status: "running",
      },
    })
    state = reduceConversation(state, {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "interrupted",
    })
    expect(state.activeTurnId).toBeUndefined()
    expect(state.items[item]?.status).toBe("running")
    expect(effectiveItemStatus(state, state.items[item]!)).toBe("interrupted")

    state = reduceConversation(state, {
      type: "item.completed",
      threadId: thread,
      item: {
        id: item,
        turnId: turn,
        kind: "reasoning",
        markdown: "authoritative final text",
        status: "interrupted",
      },
    })
    expect(state.items[item]).toMatchObject({
      markdown: "authoritative final text",
      status: "interrupted",
    })

    const late = itemId("late")
    state = reduceConversation(state, {
      type: "item.started",
      threadId: thread,
      item: {
        id: late,
        turnId: turn,
        kind: "reasoning",
        markdown: "late",
        status: "running",
      },
    })
    expect(effectiveItemStatus(state, state.items[late]!)).toBe("interrupted")
  })
})

describe("persistent canonical item records", () => {
  test("path-copies one item logarithmically while preserving prior snapshots and the dense reference", () => {
    const values = Object.create(null) as Record<string, ConversationItem>
    for (let index = 0; index < 10_000; index++) {
      const value = runningItem(`item-${String(index).padStart(5, "0")}`)
      values[value.id] = value
    }
    const normalization = itemDiagnostics()
    const beforeItems = persistentConversationItems(
      Object.freeze(values),
      normalization,
    )
    expect(normalization.conversationItemRecordNormalizations).toBe(1)
    expect(normalization.conversationItemRecordNormalizationItemVisits).toBe(
      10_000,
    )
    const target = itemId("item-06173")
    const state = {
      threadId: threadId("record"),
      turnIds: [],
      turns: {},
      items: beforeItems,
    }
    const diagnostics = itemDiagnostics()
    const event = {
      type: "item.delta" as const,
      threadId: state.threadId,
      itemId: target,
      delta: ":next",
    }
    const after = reduceConversationWithDiagnostics(state, event, diagnostics)
    const reference = reduceConversationReference(state, event)

    expect(after).toEqual(reference)
    expect(after.items).not.toBe(beforeItems)
    expect(
      beforeItems[target]?.kind === "assistant" && beforeItems[target].markdown,
    ).toBe("value:item-06173")
    expect(
      after.items[target]?.kind === "assistant" && after.items[target].markdown,
    ).toBe("value:item-06173:next")
    expect(after.items[itemId("item-06172")]).toBe(
      beforeItems[itemId("item-06172")],
    )
    expect(diagnostics.conversationItemRecordNormalizations).toBe(0)
    expect(diagnostics.conversationItemRecordNormalizationItemVisits).toBe(0)
    expect(diagnostics.conversationItemRecordLookups).toBe(1)
    expect(diagnostics.conversationItemRecordUpdates).toBe(1)
    expect(
      diagnostics.conversationItemRecordLookupNodeVisits,
    ).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(10_001)))
    expect(diagnostics.conversationItemRecordNodeVisits).toBeLessThanOrEqual(
      2 * Math.ceil(Math.log2(10_001)),
    )
    expect(diagnostics.conversationItemRecordNodesCopied).toBeLessThanOrEqual(
      4 * Math.ceil(Math.log2(10_001)),
    )
  })

  test("retains ordinary key order, reflection, JSON, and special opaque ids", () => {
    let values = persistentConversationItems()
    for (const key of [
      "named-first",
      "10",
      "2",
      "__proto__",
      "constructor",
      "toString",
      "named-last",
    ]) {
      values = setConversationItem(values, runningItem(key))
    }
    values = setConversationItem(values, {
      id: itemId("named-first"),
      turnId: turnId("record-turn"),
      kind: "assistant",
      markdown: "updated",
      status: "running",
    })
    const expectedKeys = [
      "2",
      "10",
      "named-first",
      "__proto__",
      "constructor",
      "toString",
      "named-last",
    ]

    expect(Object.keys(values)).toEqual(expectedKeys)
    expect(Object.entries(values).map(([key]) => key)).toEqual(expectedKeys)
    expect(Object.values(values).map((item) => String(item.id))).toEqual(
      expectedKeys,
    )
    expect(Object.hasOwn(values, "__proto__")).toBe(true)
    expect(
      Object.getOwnPropertyDescriptor(values, "constructor"),
    ).toMatchObject({ enumerable: true, writable: false })
    expect(
      ({ ...values } as Record<string, ConversationItem>)["__proto__"],
    ).toBe(values["__proto__"])
    expect(Object.keys(JSON.parse(JSON.stringify(values)))).toEqual(
      expectedKeys,
    )
    expect(Reflect.set(values, "extra", runningItem("extra"))).toBe(false)
    expect(Reflect.deleteProperty(values, "named-first")).toBe(false)
    expect(
      Reflect.defineProperty(values, "extra", { value: runningItem("extra") }),
    ).toBe(false)
    expect(Reflect.setPrototypeOf(values, { polluted: true })).toBe(false)
    expect(Reflect.preventExtensions(values)).toBe(false)
    expect(() => Object.freeze(values)).toThrow(TypeError)
    expect(Object.keys(values)).toEqual(expectedKeys)
    expect(values["__proto__"]?.id).toBe(itemId("__proto__"))
  })

  test("handles prototype-named ids through reducer lifecycle and forks them without aliasing values", () => {
    const thread = threadId("special"),
      turn = turnId("special-turn")
    let state = reduceConversation(createConversation(thread), {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
    })
    for (const key of ["__proto__", "constructor", "toString"]) {
      const id = itemId(key)
      state = reduceConversation(state, {
        type: "item.started",
        threadId: thread,
        item: {
          id,
          turnId: turn,
          kind: "assistant",
          markdown: key,
          status: "running",
        },
      })
      state = reduceConversation(state, {
        type: "item.delta",
        threadId: thread,
        itemId: id,
        delta: ":delta",
      })
      state = reduceConversation(state, {
        type: "item.completed",
        threadId: thread,
        item: {
          id,
          turnId: turn,
          kind: "assistant",
          markdown: `${key}:complete`,
          status: "complete",
        },
      })
      expect(state.items[id]).toMatchObject({
        markdown: `${key}:complete`,
        status: "complete",
      })
    }
    state = reduceConversation(state, {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    })
    const fork = forkConversation(state, threadId("special-child"), turn)!
    expect(Object.keys(fork.items)).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ])
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(fork.items[key]).toEqual(state.items[key])
      expect(fork.items[key]).not.toBe(state.items[key])
    }
  })

  test("leaves no-op plain snapshots untouched and remains an Array.reduce-compatible callback", () => {
    const thread = threadId("plain"),
      terminal = runningItem("terminal")
    const items = Object.freeze({
      [terminal.id]: Object.freeze({
        ...terminal,
        status: "complete" as const,
      }),
    })
    const state = Object.freeze({
      threadId: thread,
      turnIds: Object.freeze([]),
      turns: Object.freeze({}),
      items,
    })
    const diagnostics = itemDiagnostics()
    expect(
      reduceConversationWithDiagnostics(
        state,
        {
          type: "item.delta",
          threadId: thread,
          itemId: terminal.id,
          delta: "ignored",
        },
        diagnostics,
      ),
    ).toBe(state)
    expect(
      reduceConversationWithDiagnostics(
        state,
        {
          type: "item.delta",
          threadId: thread,
          itemId: itemId("absent"),
          delta: "ignored",
        },
        diagnostics,
      ),
    ).toBe(state)
    expect(
      reduceConversationWithDiagnostics(
        state,
        {
          type: "item.delta",
          threadId: threadId("other"),
          itemId: terminal.id,
          delta: "ignored",
        },
        diagnostics,
      ),
    ).toBe(state)
    expect(diagnostics.conversationItemRecordNormalizations).toBe(0)
    expect(diagnostics.conversationItemRecordNormalizationItemVisits).toBe(0)
    expect(state.items).toBe(items)

    const events = [
      {
        type: "turn.started" as const,
        threadId: thread,
        turnId: turnId("array-turn"),
      },
      {
        type: "item.started" as const,
        threadId: thread,
        item: runningItem("array-item"),
      },
    ]
    expect(
      events.reduce(reduceConversation, createConversation(thread)).items[
        itemId("array-item")
      ],
    ).toBeDefined()
  })

  test("counts explicit lookups without changing the ordinary Record access contract", () => {
    const item = runningItem("lookup")
    const items = setConversationItem(persistentConversationItems(), item)
    const diagnostics = itemDiagnostics()
    expect(conversationItemAt(items, item.id, diagnostics)).toBe(item)
    expect(diagnostics.conversationItemRecordLookups).toBe(1)
    expect(diagnostics.conversationItemRecordLookupNodeVisits).toBe(1)
  })

  test("keeps replacement paths logarithmic after monotonic production-style insertion", () => {
    let items = persistentConversationItems()
    const count = 10_000
    for (let index = 0; index < count; index++) {
      items = setConversationItem(
        items,
        runningItem(`sequential-${String(index).padStart(5, "0")}`),
      )
    }
    const keys = Object.keys(items)
    expect(keys).toHaveLength(count)
    expect(keys[0]).toBe("sequential-00000")
    expect(keys.at(-1)).toBe("sequential-09999")

    const bound = Math.ceil(Math.log2(count + 1)) + 2
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      const id = `sequential-${String(index).padStart(5, "0")}`
      const diagnostics = itemDiagnostics()
      const prior = items
      items = setConversationItem(
        items,
        {
          id: itemId(id),
          turnId: turnId("record-turn"),
          kind: "assistant",
          markdown: `updated:${id}`,
          status: "running",
        },
        diagnostics,
      )
      expect(items).not.toBe(prior)
      expect(prior[itemId(id)]).not.toBe(items[itemId(id)])
      expect(diagnostics.conversationItemRecordNormalizations).toBe(0)
      expect(diagnostics.conversationItemRecordUpdates).toBe(1)
      expect(diagnostics.conversationItemRecordNodeVisits).toBeLessThanOrEqual(
        bound,
      )
      expect(diagnostics.conversationItemRecordNodesCopied).toBeLessThanOrEqual(
        2 * bound,
      )
    }
    expect(Object.keys(items)).toEqual(keys)
  })
})

for (const [outcome, expected] of [
  ["complete", "complete"],
  ["failed", "error"],
  ["interrupted", "interrupted"],
] as const) {
  test(`effective item status settles ${outcome} turns without overriding completed items`, () => {
    const thread = threadId("status"),
      turn = turnId("turn"),
      id = itemId("item")
    const state = reduceConversation(createConversation(thread), {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome,
    })
    const item = {
      id,
      turnId: turn,
      kind: "assistant" as const,
      markdown: "Final text",
      status: "running" as const,
    }
    expect(effectiveItemStatus(state, item)).toBe(expected)
    expect(effectiveItemStatus(state, { ...item, status: "complete" })).toBe(
      "complete",
    )
    expect(item.status).toBe("running")
  })
}

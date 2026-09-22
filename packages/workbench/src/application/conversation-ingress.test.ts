import { expect, test } from "bun:test"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
  type ConversationEvent,
} from "@vimex/conversation"
import {
  ConversationIngress,
  type ConversationIngressScheduler,
} from "./conversation-ingress"

function manualScheduler() {
  const tasks: Array<{
    task: () => void
    delayMs: number
    cancelled: boolean
  }> = []
  const scheduler: ConversationIngressScheduler = {
    schedule(task, delayMs) {
      const entry = { task, delayMs, cancelled: false }
      tasks.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    scheduler,
    tasks,
    runNext() {
      const entry = tasks.shift()
      if (entry && !entry.cancelled) entry.task()
    },
  }
}

test("coalesces adjacent matching deltas on one scheduled settlement", () => {
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  const ingress = new ConversationIngress((events) => emitted.push(...events), {
    scheduler: manual.scheduler,
  })
  const thread = threadId("thread"),
    item = itemId("item")
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "a",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "b",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "c",
  })
  expect(emitted).toEqual([])
  expect(manual.tasks).toHaveLength(1)
  manual.runNext()
  expect(emitted).toEqual([
    { type: "item.delta", threadId: thread, itemId: item, delta: "abc" },
  ])
})

test("coalesces every item delta in one cadence while preserving first-seen item order", () => {
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  const ingress = new ConversationIngress((events) => emitted.push(...events), {
    scheduler: manual.scheduler,
  })
  const thread = threadId("thread"),
    first = itemId("first"),
    second = itemId("second")
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: first,
    delta: "a",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: second,
    delta: "b",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: first,
    delta: "c",
  })
  ingress.flush()
  expect(
    emitted.map((event) =>
      event.type === "item.delta"
        ? `${event.itemId}:${event.delta}`
        : event.type,
    ),
  ).toEqual(["first:ac", "second:b"])
  manual.runNext()
  expect(emitted).toHaveLength(2)
})

test("bounds distinct scheduled delta streams and yields before continuing backlog", () => {
  const emitted: string[][] = []
  const manual = manualScheduler()
  const ingress = new ConversationIngress(
    (events) =>
      emitted.push(
        events.map((event) =>
          event.type === "item.delta" ? event.itemId : event.type,
        ),
      ),
    {
      scheduler: manual.scheduler,
      maxEventsPerTurn: 2,
    },
  )
  const thread = threadId("thread")
  for (let index = 0; index < 5; index++)
    ingress.push({
      type: "item.delta",
      threadId: thread,
      itemId: itemId(`item-${index}`),
      delta: "x",
    })
  expect(manual.tasks.map((task) => task.delayMs)).toEqual([16])
  manual.runNext()
  expect(emitted).toEqual([["item-0", "item-1"]])
  expect(ingress.hasPending).toBe(true)
  expect(manual.tasks.at(-1)?.delayMs).toBe(0)
  manual.runNext()
  expect(emitted).toEqual([
    ["item-0", "item-1"],
    ["item-2", "item-3"],
  ])
  manual.runNext()
  expect(emitted).toEqual([
    ["item-0", "item-1"],
    ["item-2", "item-3"],
    ["item-4"],
  ])
  expect(ingress.hasPending).toBe(false)
})

test("flushes pending text before every non-delta conversation boundary", () => {
  const thread = threadId("thread"),
    turn = turnId("turn"),
    item = itemId("item")
  const boundaries: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: turn },
    {
      type: "item.started",
      threadId: thread,
      item: {
        id: item,
        turnId: turn,
        kind: "assistant",
        markdown: "",
        status: "running",
      },
    },
    {
      type: "item.completed",
      threadId: thread,
      item: {
        id: item,
        turnId: turn,
        kind: "assistant",
        markdown: "done",
        status: "complete",
      },
    },
    {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    },
  ]
  for (const boundary of boundaries) {
    const emitted: ConversationEvent[] = []
    const manual = manualScheduler()
    const ingress = new ConversationIngress(
      (events) => emitted.push(...events),
      { scheduler: manual.scheduler },
    )
    ingress.push({
      type: "item.delta",
      threadId: thread,
      itemId: item,
      delta: "before",
    })
    ingress.push(boundary)
    expect(emitted.map((event) => event.type)).toEqual([
      "item.delta",
      boundary.type,
    ])
    manual.runNext()
    expect(emitted).toHaveLength(2)
  }
})

test("retries the entire atomic batch when delivery throws before commit", () => {
  const thread = threadId("thread"),
    first = itemId("first"),
    second = itemId("second"),
    third = itemId("third")
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  let attempts = 0
  const ingress = new ConversationIngress(
    (events) => {
      attempts++
      if (attempts === 1) throw new Error("commit failed")
      emitted.push(...events)
    },
    { scheduler: manual.scheduler },
  )
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: first,
    delta: "a",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: second,
    delta: "b",
  })
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: third,
    delta: "c",
  })
  expect(() => ingress.flush()).toThrow("commit failed")
  expect(ingress.hasPending).toBe(true)
  manual.runNext() // cancelled callback from the original cadence window
  expect(emitted).toHaveLength(0)
  manual.runNext()
  expect(
    emitted.map((event) =>
      event.type === "item.delta"
        ? `${event.itemId}:${event.delta}`
        : event.type,
    ),
  ).toEqual(["first:a", "second:b", "third:c"])
  expect(ingress.hasPending).toBe(false)
})

test("retains a semantic boundary when its preceding batch fails", () => {
  const thread = threadId("thread"),
    turn = turnId("turn"),
    item = itemId("item")
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  let fail = true
  const ingress = new ConversationIngress(
    (events) => {
      if (fail) {
        fail = false
        throw new Error("commit failed")
      }
      emitted.push(...events)
    },
    { scheduler: manual.scheduler },
  )
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "text",
  })
  expect(() =>
    ingress.push({
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    }),
  ).toThrow("commit failed")
  expect(ingress.hasPending).toBe(true)
  ingress.flush()
  expect(emitted.map((event) => event.type)).toEqual([
    "item.delta",
    "turn.completed",
  ])
})

test("retries a failed semantic-boundary prefix atomically even above the scheduled cap", () => {
  const thread = threadId("thread"),
    turn = turnId("turn")
  const manual = manualScheduler()
  const batches: string[][] = []
  let fail = true
  const ingress = new ConversationIngress(
    (events) => {
      if (fail) {
        fail = false
        throw new Error("commit failed")
      }
      batches.push(
        events.map((event) =>
          event.type === "item.delta" ? event.itemId : event.type,
        ),
      )
    },
    { scheduler: manual.scheduler, maxEventsPerTurn: 2 },
  )
  for (let index = 0; index < 3; index++)
    ingress.push({
      type: "item.delta",
      threadId: thread,
      itemId: itemId(`item-${index}`),
      delta: "x",
    })
  expect(() =>
    ingress.push({
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    }),
  ).toThrow("commit failed")
  manual.runNext() // cancelled cadence callback
  manual.runNext() // atomic retry
  expect(batches).toEqual([["item-0", "item-1", "item-2", "turn.completed"]])
  expect(ingress.hasPending).toBe(false)
})

test("new deltas never coalesce backward across a retained failed boundary", () => {
  const thread = threadId("thread"),
    turn = turnId("turn"),
    item = itemId("item")
  const manual = manualScheduler()
  const batches: string[][] = []
  let fail = true
  const ingress = new ConversationIngress(
    (events) => {
      if (fail) {
        fail = false
        throw new Error("commit failed")
      }
      batches.push(
        events.map((event) =>
          event.type === "item.delta" ? event.delta : event.type,
        ),
      )
    },
    { scheduler: manual.scheduler, maxEventsPerTurn: 2 },
  )
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "before",
  })
  expect(() =>
    ingress.push({
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
    }),
  ).toThrow("commit failed")
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "after",
  })
  manual.runNext() // cancelled cadence callback
  manual.runNext() // failed prefix
  manual.runNext() // suffix continuation
  expect(batches).toEqual([["before", "turn.completed"], ["after"]])
})

test("scheduled failure reports once, retains the batch, and does not hot-loop", () => {
  const thread = threadId("thread"),
    item = itemId("item")
  const manual = manualScheduler()
  const errors: unknown[] = []
  const emitted: ConversationEvent[] = []
  let fail = true
  const ingress = new ConversationIngress(
    (events) => {
      if (fail) throw new Error("commit failed")
      emitted.push(...events)
    },
    { scheduler: manual.scheduler, onError: (error) => errors.push(error) },
  )
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "text",
  })
  manual.runNext()
  expect(errors).toHaveLength(1)
  expect(ingress.hasPending).toBe(true)
  fail = false
  ingress.flush()
  expect(emitted).toEqual([
    { type: "item.delta", threadId: thread, itemId: item, delta: "text" },
  ])
  manual.runNext()
  expect(emitted).toHaveLength(1)
})

test("coalesced and uncoalesced streams reduce to the same canonical state", () => {
  const thread = threadId("thread"),
    turn = turnId("turn"),
    id = itemId("answer"),
    reasoning = itemId("reasoning")
  const events: ConversationEvent[] = [
    { type: "turn.started", threadId: thread, turnId: turn },
    {
      type: "item.started",
      threadId: thread,
      item: {
        id,
        turnId: turn,
        kind: "assistant",
        markdown: "",
        status: "running",
      },
    },
    {
      type: "item.started",
      threadId: thread,
      item: {
        id: reasoning,
        turnId: turn,
        kind: "reasoning",
        markdown: "",
        status: "running",
      },
    },
    { type: "item.delta", threadId: thread, itemId: id, delta: "one" },
    {
      type: "item.delta",
      threadId: thread,
      itemId: reasoning,
      delta: "middle",
    },
    { type: "item.delta", threadId: thread, itemId: id, delta: " three" },
    {
      type: "item.delta",
      threadId: thread,
      itemId: reasoning,
      delta: " layer",
    },
  ]
  const direct = events.reduce(reduceConversation, createConversation(thread))
  let settled = createConversation(thread)
  const manual = manualScheduler()
  const ingress = new ConversationIngress(
    (events) => {
      for (const event of events) settled = reduceConversation(settled, event)
    },
    { scheduler: manual.scheduler },
  )
  for (const event of events) ingress.push(event)
  ingress.flush()
  expect(settled).toEqual(direct)
})

test("close flushes once and rejects later delivery", () => {
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  const ingress = new ConversationIngress((events) => emitted.push(...events), {
    scheduler: manual.scheduler,
  })
  const thread = threadId("thread"),
    item = itemId("item")
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "kept",
  })
  ingress.close()
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: item,
    delta: "dropped",
  })
  manual.runNext()
  expect(emitted).toEqual([
    { type: "item.delta", threadId: thread, itemId: item, delta: "kept" },
  ])
})

test("close rejects re-entrant input before its final drain", () => {
  const thread = threadId("thread"),
    first = itemId("first"),
    reentrant = itemId("reentrant")
  const emitted: ConversationEvent[] = []
  const manual = manualScheduler()
  let ingress!: ConversationIngress
  ingress = new ConversationIngress(
    (events) => {
      emitted.push(...events)
      ingress.push({
        type: "item.delta",
        threadId: thread,
        itemId: reentrant,
        delta: "late",
      })
    },
    { scheduler: manual.scheduler },
  )
  ingress.push({
    type: "item.delta",
    threadId: thread,
    itemId: first,
    delta: "kept",
  })
  ingress.close()
  expect(ingress.hasPending).toBe(false)
  manual.runNext()
  expect(
    emitted.map((event) =>
      event.type === "item.delta"
        ? `${event.itemId}:${event.delta}`
        : event.type,
    ),
  ).toEqual(["first:kept"])
})

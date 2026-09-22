import { expect, test } from "bun:test"
import {
  createConversation,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import { createRpcEventReplay } from "./rpc-event-replay"

test("RPC replay admits only timing enrichment for already observed turns", () => {
  const thread = threadId("thread"),
    turn = turnId("turn")
  let conversation = reduceConversation(createConversation(thread), {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  let replay = createRpcEventReplay(conversation)
  const startTiming = {
    type: "turn.started" as const,
    threadId: thread,
    turnId: turn,
    startedAt: 1_000,
  }
  expect(replay(conversation, startTiming)).toBe(true)
  conversation = reduceConversation(conversation, startTiming)
  expect(replay(conversation, startTiming)).toBe(false)

  conversation = reduceConversation(conversation, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
  })
  replay = createRpcEventReplay(conversation)
  const completionTiming = {
    type: "turn.completed" as const,
    threadId: thread,
    turnId: turn,
    outcome: "failed" as const,
    completedAt: 3_500,
    durationMs: 2_500,
  }
  expect(replay(conversation, completionTiming)).toBe(true)
  conversation = reduceConversation(conversation, completionTiming)
  expect(conversation.turns[turn]).toMatchObject({
    status: "complete",
    startedAt: 1_000,
    completedAt: 3_500,
    durationMs: 2_500,
  })
  expect(replay(conversation, completionTiming)).toBe(false)
})

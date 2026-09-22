import { describe, expect, test } from "bun:test"
import {
  failOutgoing,
  firstQueuedMessage,
  initialComposer,
  markOutgoingSending,
  retryOutgoing,
  submitDraft,
  updateDraft,
} from "./index"

describe("composer", () => {
  test("uses grapheme cursor offsets and queues next-turn messages", () => {
    let state = updateDraft(initialComposer(), "a👨‍👩‍👧‍👦b", 99)
    expect(state.cursorOffset).toBe(3)
    state = submitDraft(state, "next-turn", true, "m1")
    expect(firstQueuedMessage(state)).toMatchObject({
      id: "m1",
      text: "a👨‍👩‍👧‍👦b",
      status: "queued",
    })
    expect(markOutgoingSending(state, "m1").outbox[0]?.status).toBe("sending")
  })

  test("steer sends immediately even while a turn is active", () => {
    const state = submitDraft(
      updateDraft(initialComposer(), "redirect"),
      "steer",
      false,
      "m2",
    )
    expect(state.outbox[0]?.status).toBe("sending")
  })

  test("rejects duplicate client message ids", () => {
    let state = submitDraft(
      updateDraft(initialComposer(), "first"),
      "next-turn",
      false,
      "same",
    )
    state = updateDraft(state, "duplicate")
    expect(submitDraft(state, "next-turn", false, "same")).toBe(state)
  })

  test("filters queued intents and exposes failed messages for retry", () => {
    let state = submitDraft(
      updateDraft(initialComposer(), "redirect"),
      "steer",
      true,
      "steer",
    )
    state = submitDraft(updateDraft(state, "next"), "next-turn", true, "next")
    expect(firstQueuedMessage(state, "steer")?.id).toBe("steer")
    expect(firstQueuedMessage(state, "next-turn")?.id).toBe("next")
    state = failOutgoing(state, "steer", "offline")
    expect(state.outbox[0]).toMatchObject({
      status: "failed",
      reason: "offline",
      text: "redirect",
    })
    expect(retryOutgoing(state, "steer", false).outbox[0]).toMatchObject({
      status: "sending",
      reason: undefined,
    })
  })
})

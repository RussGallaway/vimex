import { describe, expect, test } from "bun:test"
import {
  attachImage,
  composerParts,
  failOutgoing,
  firstQueuedMessage,
  initialComposer,
  markOutgoingSending,
  retryOutgoing,
  removeImage,
  removeQueuedOutgoing,
  submitDraft,
  unqueueOutgoing,
  updateDraft,
} from "./index"

describe("composer", () => {
  test("keeps image-only drafts in queued, failed, and retried submissions", () => {
    const image = {
      id: "image-1",
      label: "capture.png",
      path: "/owned/capture.png",
    }
    let state = attachImage(initialComposer(), image)
    expect(attachImage(state, image)).toBe(state)
    state = submitDraft(state, "next-turn", true, "message")
    expect(state.images).toEqual([])
    expect(state.outbox[0]).toMatchObject({
      text: "[Image 1]",
      images: [{ ...image, marker: "[Image 1]" }],
      status: "queued",
    })
    state = failOutgoing(state, "message", "offline")
    expect(retryOutgoing(state, "message", false).outbox[0]?.images).toEqual([
      { ...image, marker: "[Image 1]" },
    ])
    state = attachImage(state, image)
    expect(removeImage(state, image.id)).toMatchObject({ text: "", images: [] })
    expect(state.outbox[0]?.images).toEqual([{ ...image, marker: "[Image 1]" }])
  })
  test("keeps images at their cursor position while text is edited around them", () => {
    const image = { id: "middle", label: "photo.png", path: "/owned/photo.png" }
    let state = updateDraft(initialComposer(), "hello world", 6)
    state = attachImage(state, image)
    expect(state.text).toBe("hello [Image 1] world")
    expect(state.cursorOffset).toBe(16)
    state = updateDraft(state, "hello [Image 1] beautiful world")
    expect(composerParts(state.text, state.images)).toEqual([
      { type: "text", text: "hello " },
      { type: "image", path: "/owned/photo.png" },
      { type: "text", text: " beautiful world" },
    ])
    expect(updateDraft(state, "hello beautiful world").images).toEqual([])
    expect(removeImage(state, image.id).text).toBe("hello beautiful world")
  })
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

  test("unqueues text and images into an empty draft and refuses to overwrite a draft", () => {
    const image = { id: "image", label: "shot.png", path: "/tmp/shot.png" }
    let state = attachImage(updateDraft(initialComposer(), "inspect", 7), image)
    state = submitDraft(state, "next-turn", true, "first")
    state = submitDraft(
      updateDraft(state, "later"),
      "next-turn",
      true,
      "second",
    )
    const withDraft = updateDraft(state, "new draft")
    expect(unqueueOutgoing(withDraft, "first")).toBe(withDraft)
    const restored = unqueueOutgoing(state, "first")
    expect(restored.text).toBe("inspect [Image 1]")
    expect(restored.images).toEqual(state.outbox[0]!.images!)
    expect(restored.outbox.map((message) => message.id)).toEqual(["second"])
    expect(restored.cursorOffset).toBe(17)
  })

  test("removes only queued messages; sending messages cannot be taken back", () => {
    let state = submitDraft(
      updateDraft(initialComposer(), "queued"),
      "next-turn",
      true,
      "queued",
    )
    state = submitDraft(
      updateDraft(state, "sending"),
      "steer",
      false,
      "sending",
    )
    expect(unqueueOutgoing(state, "sending")).toBe(state)
    expect(removeQueuedOutgoing(state, "sending")).toBe(state)
    expect(
      removeQueuedOutgoing(state, "queued").outbox.map((message) => message.id),
    ).toEqual(["sending"])
  })
})

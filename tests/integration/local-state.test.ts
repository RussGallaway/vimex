import { test, expect } from "bun:test"
import { createWorkspace, initialWorkbench, openThread } from "@vimex/workbench"
import { itemId, threadId, turnId } from "@vimex/conversation"
import { syncTranscriptItem } from "@vimex/transcript"
import { captureLocalState, emptyLocalState, parseLocalState, restoreThreadView, type SavedThreadView } from "@vimex/workbench"
const id = threadId("thread")
const saved: SavedThreadView = { draft: "👨‍👩‍👧‍👦 reply", cursorOffset: 3, folded: { message: true, gone: true }, cursor: { itemId: itemId("message"), graphemeOffset: 99 }, viewport: { kind: "point", point: { itemId: itemId("message"), graphemeOffset: 3 }, preferredScreenRow: 2 }, surface: "composer", outbox: [] }

test("local view round-trips drafts and clamps positions to hydrated content", () => {
  const local = parseLocalState(JSON.parse(JSON.stringify({ version: 1, threads: { thread: saved } })))
  const workspace = createWorkspace(id)
  workspace.transcript = syncTranscriptItem(workspace.transcript, { id: itemId("message"), turnId: turnId("turn"), kind: "assistant", markdown: "hello", status: "complete" })
  const restored = restoreThreadView(workspace, local.threads.thread!)
  expect(restored.composer.text).toBe(saved.draft)
  expect(restored.composer.cursorOffset).toBe(3)
  expect(restored.transcript.cursor?.graphemeOffset).toBe(5)
  expect(restored.transcript.folded).toEqual({ message: true })
  expect(restored.interaction).toMatchObject({ mode: "normal", surface: "composer" })
})

test("listing unloaded sessions preserves saved drafts", () => {
  const state = openThread(initialWorkbench(), { id, title: "thread", cwd: "/tmp", model: "model", reasoningEffort: "high", status: "idle" })
  expect(captureLocalState(state, { version: 1, threads: { thread: saved } }).threads.thread).toEqual(saved)
})

test("invalid state is rejected and missing historical anchors safely return to tail", () => {
  expect(() => parseLocalState({ version: 2, threads: {} })).toThrow()
  expect(() => parseLocalState({ version: 1, threads: { thread: { ...saved, cursorOffset: -1 } } })).toThrow()
  expect(restoreThreadView(createWorkspace(id), saved).transcript.viewport).toEqual({ kind: "tail" })
})

test("unacknowledged submissions survive restart as explicit failed retries", () => {
  const workspace = createWorkspace(id)
  workspace.composer = {
    ...workspace.composer,
    outbox: [
      { id: "sending", text: "possibly delivered", intent: "next-turn", status: "sending" },
      { id: "queued", text: "send later", intent: "next-turn", status: "queued" },
      { id: "failed", text: "known failure", intent: "steer", status: "failed", reason: "offline" },
    ],
  }
  const state = { ...openThread(initialWorkbench(), { id, title: "thread", cwd: "/tmp", model: "model", reasoningEffort: "high", status: "idle" }), workspaces: { [id]: workspace } }
  const captured = parseLocalState(JSON.parse(JSON.stringify(captureLocalState(state, emptyLocalState()))))
  const restored = restoreThreadView(createWorkspace(id), captured.threads[id]!)
  expect(restored.composer.outbox.map(message => message.status)).toEqual(["failed", "failed", "failed"])
  expect(restored.composer.outbox[0]?.reason).toContain("not confirmed")
  expect(restored.composer.outbox[1]?.text).toBe("send later")
  expect(restored.composer.outbox[2]?.reason).toBe("offline")
})

test("version-one state without an outbox remains compatible", () => {
  const legacy = { ...saved } as Partial<SavedThreadView>
  delete legacy.outbox
  expect(parseLocalState({ version: 1, threads: { thread: legacy } }).threads.thread?.outbox).toEqual([])
})

test("explicitly unfolded items survive serialization and history restoration", () => {
  const local = parseLocalState({ version: 1, threads: { thread: { ...saved, folded: { message: false } } } })
  const workspace = createWorkspace(id)
  workspace.transcript = syncTranscriptItem(workspace.transcript, { id: itemId("message"), turnId: turnId("turn"), kind: "command", title: "tool", detail: "output", status: "complete" })
  const restored = restoreThreadView(workspace, local.threads.thread!)
  expect(restored.transcript.folded).toEqual({ message: false })
  expect(() => parseLocalState({ version: 1, threads: { thread: { ...saved, folded: { message: "false" } } } })).toThrow()
})

test("favorites persist even for unloaded threads and older state remains valid", () => {
  const state = { ...initialWorkbench(), favoriteThreadIds: [id] }
  const captured = parseLocalState(JSON.parse(JSON.stringify(captureLocalState(state, emptyLocalState()))))
  expect(captured.favoriteThreadIds).toEqual([id])
  expect(captured.threads).toEqual({})
  expect(parseLocalState({ version: 1, threads: {} }).favoriteThreadIds).toBeUndefined()
  expect(() => parseLocalState({ version: 1, threads: {}, favoriteThreadIds: [123] })).toThrow()
})

test("marks and jumplists persist as source offsets and restore across Markdown reflow", () => {
  const workspace = createWorkspace(id)
  workspace.transcript = syncTranscriptItem(workspace.transcript, { id: itemId("message"), turnId: turnId("turn"), kind: "assistant", markdown: "prefix **bold**", status: "complete" })
  const location = { point: { itemId: itemId("message"), graphemeOffset: 8 }, preferredScreenRow: 3 }
  workspace.transcript = { ...workspace.transcript, marks: { a: location }, jumps: { back: [location], forward: [] } }
  const state = { ...openThread(initialWorkbench(), { id, title: "thread", cwd: "/tmp", model: "model", reasoningEffort: "high", status: "idle" }), workspaces: { [id]: workspace } }
  const captured = parseLocalState(JSON.parse(JSON.stringify(captureLocalState(state, emptyLocalState()))))
  expect(captured.threads[id]?.marks?.a?.sourceOffset).toBeGreaterThan(8)
  const resumed = createWorkspace(id)
  resumed.transcript = syncTranscriptItem(resumed.transcript, { id: itemId("message"), turnId: turnId("turn"), kind: "assistant", markdown: "prefix **bold** and more", status: "complete" })
  const restored = restoreThreadView(resumed, captured.threads[id]!)
  expect(restored.transcript.marks.a?.point.graphemeOffset).toBe(8)
  expect(restored.transcript.jumps.back).toEqual([restored.transcript.marks.a!])
  expect(() => parseLocalState({ version: 1, threads: { thread: { ...saved, marks: { bad: { itemId: "message", sourceOffset: -1, preferredScreenRow: 0 } } } } })).toThrow()
})

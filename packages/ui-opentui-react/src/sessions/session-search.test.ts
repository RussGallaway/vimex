import { expect, test } from "bun:test"
import { threadId, type ThreadSummary } from "@vimex/conversation"
import { searchSessions } from "./session-search"

test("session search fuzzily matches metadata and otherwise sorts by recency", () => {
  const old = threadId("old"), recent = threadId("recent")
  const summaries: Record<string, ThreadSummary> = {
    [old]: { id: old, title: "Alpha migration", cwd: "/work/client", gitBranch: "feature/auth", model: "gpt-6", reasoningEffort: "high", status: "idle", updatedAt: 10 },
    [recent]: { id: recent, title: "Release notes", cwd: "/work/vimex", gitBranch: "main", model: "gpt-6", reasoningEffort: "high", status: "working", updatedAt: 20 },
  }
  expect(searchSessions([old, recent], summaries, "").map((row) => row.id)).toEqual([recent, old])
  expect(searchSessions([old, recent], summaries, "fau").map((row) => row.id)).toEqual([old])
  expect(searchSessions([old, recent], summaries, "vmx").map((row) => row.id)).toEqual([recent])
})

test("an exact resumable Codex thread ID never fuzzily selects another session", () => {
  const target = threadId("01a0b1fa-cd31-7f11-b465-275ed3d0c21c")
  const unrelated = threadId("01a0a11c-1034-7b70-8105-b3a5f0924306")
  expect(searchSessions([unrelated], {}, target)).toEqual([{ id: target }])
})

test("favorites sort before recency without bypassing filters or exact IDs", () => {
  const old = threadId("old"), recent = threadId("recent")
  const summaries: Record<string, ThreadSummary> = {
    [old]: { id: old, title: "Old favorite", cwd: "/one", model: "test", reasoningEffort: "high", status: "idle", updatedAt: 1 },
    [recent]: { id: recent, title: "New session", cwd: "/two", model: "test", reasoningEffort: "high", status: "idle", updatedAt: 10 },
  }
  expect(searchSessions([recent, old], summaries, "", [old]).map(row => row.id)).toEqual([old, recent])
  expect(searchSessions([recent, old], summaries, "", [old])[0]?.favorite).toBe(true)
  expect(searchSessions([recent, old], summaries, "New", [old]).map(row => row.id)).toEqual([recent])
  expect(searchSessions([recent, old], summaries, "recent", [old]).map(row => row.id)).toEqual([recent])
})


test("persisted favorites remain resumable when omitted from server thread list", () => {
  const favorite = threadId("favorite-fork")
  expect(searchSessions([], {}, "", [favorite])).toEqual([{ id: favorite, summary: undefined, favorite: true }])
  expect(searchSessions([], {}, "unrelated", [favorite])).toEqual([])
})

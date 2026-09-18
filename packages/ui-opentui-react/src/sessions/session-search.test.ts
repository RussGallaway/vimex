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

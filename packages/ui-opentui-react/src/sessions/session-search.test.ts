import { expect, test } from "bun:test"
import { threadId, type ThreadSummary } from "@vimex/conversation"
import { searchSessions } from "./session-search"

test("session search fuzzily matches metadata and otherwise sorts by recency", () => {
  const old = threadId("old"),
    recent = threadId("recent")
  const summaries: Record<string, ThreadSummary> = {
    [old]: {
      id: old,
      title: "Alpha migration",
      cwd: "/work/client",
      gitBranch: "feature/auth",
      model: "gpt-6",
      reasoningEffort: "high",
      status: "idle",
      updatedAt: 10,
    },
    [recent]: {
      id: recent,
      title: "Release notes",
      cwd: "/work/vimex",
      gitBranch: "main",
      model: "gpt-6",
      reasoningEffort: "high",
      status: "working",
      updatedAt: 20,
    },
  }
  expect(
    searchSessions([old, recent], summaries, "").map((row) => row.id),
  ).toEqual([recent, old])
  expect(
    searchSessions([old, recent], summaries, "fau").map((row) => row.id),
  ).toEqual([old])
  expect(
    searchSessions([old, recent], summaries, "vmx").map((row) => row.id),
  ).toEqual([recent])
})

test("an exact resumable Codex thread ID never fuzzily selects another session", () => {
  const target = threadId("01a0b1fa-cd31-7f11-b465-275ed3d0c21c")
  const unrelated = threadId("01a0a11c-1034-7b70-8105-b3a5f0924306")
  expect(searchSessions([unrelated], {}, target)).toEqual([{ id: target }])
})

test("child sessions stay out of the ordinary picker but remain addressable by ID", () => {
  const parent = threadId("parent")
  const child = threadId("child")
  const summaries: Record<string, ThreadSummary> = {
    [parent]: {
      id: parent,
      title: "Parent session",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
    [child]: {
      id: child,
      parentThreadId: parent,
      title: "Child session",
      cwd: "/work",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
    },
  }
  expect(searchSessions([parent, child], summaries, "", [], "/work")).toEqual([
    { id: parent, summary: summaries[parent] },
  ])
  expect(
    searchSessions([parent, child], summaries, child, [], "/work"),
  ).toEqual([{ id: child, summary: summaries[child] }])
})

test("side IDs stay out of the picker even when listed, favorited, or typed exactly", () => {
  const parent = threadId("parent")
  const side = threadId("01a0b1fa-cd31-7f11-b465-275ed3d0c21c")
  const excluded = new Set([side])
  expect(
    searchSessions([parent, side], {}, "", [side], undefined, excluded),
  ).toEqual([{ id: parent, summary: undefined }])
  expect(
    searchSessions([parent, side], {}, side, [side], undefined, excluded),
  ).toEqual([])
})

test("favorites sort before recency without bypassing filters or exact IDs", () => {
  const old = threadId("old"),
    recent = threadId("recent")
  const summaries: Record<string, ThreadSummary> = {
    [old]: {
      id: old,
      title: "Old favorite",
      cwd: "/one",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
      updatedAt: 1,
    },
    [recent]: {
      id: recent,
      title: "New session",
      cwd: "/two",
      model: "test",
      reasoningEffort: "high",
      status: "idle",
      updatedAt: 10,
    },
  }
  expect(
    searchSessions([recent, old], summaries, "", [old]).map((row) => row.id),
  ).toEqual([old, recent])
  expect(searchSessions([recent, old], summaries, "", [old])[0]?.favorite).toBe(
    true,
  )
  expect(
    searchSessions([recent, old], summaries, "New", [old]).map((row) => row.id),
  ).toEqual([recent])
  expect(
    searchSessions([recent, old], summaries, "recent", [old]).map(
      (row) => row.id,
    ),
  ).toEqual([recent])
})

test("persisted favorites remain resumable when omitted from server thread list", () => {
  const favorite = threadId("favorite-fork")
  expect(searchSessions([], {}, "", [favorite])).toEqual([
    { id: favorite, summary: undefined, favorite: true },
  ])
  expect(searchSessions([], {}, "unrelated", [favorite])).toEqual([])
})

test("directory scope excludes other-directory favorites and permits All scope", () => {
  const local = threadId("local"),
    other = threadId("other"),
    nested = threadId("nested")
  const base = {
    title: "Session",
    model: "test",
    reasoningEffort: "high",
    status: "idle" as const,
  }
  const summaries = {
    [local]: { ...base, id: local, cwd: "/work/project/" },
    [other]: { ...base, id: other, cwd: "/work/other" },
    [nested]: { ...base, id: nested, cwd: "/work/project/nested" },
  }
  expect(
    searchSessions(
      [local, other, nested],
      summaries,
      "",
      [other],
      "/work/project",
    ).map((row) => row.id),
  ).toEqual([local])
  expect(
    searchSessions([local, other], summaries, "", [other]).map((row) => row.id),
  ).toEqual([other, local])
  expect(
    searchSessions(
      [local, other],
      summaries,
      "other",
      [other],
      "/work/project",
    ),
  ).toEqual([])
})

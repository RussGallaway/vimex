import { expect, test } from "bun:test"
import { threadId, type ThreadSummary } from "@vimex/conversation"
import { HerdrReporter } from "./lifecycle-reporter"

const thread: ThreadSummary = {
  id: threadId("thread-one"),
  title: "Vimex",
  cwd: "/tmp/repo",
  model: "model",
  reasoningEffort: "high",
  status: "working",
}

test("is inert outside an explicitly managed pane", async () => {
  const commands: string[][] = []
  const reporter = new HerdrReporter(undefined, async (args) => {
    commands.push([...args])
  })
  await reporter.report({ summary: thread, connection: "connected" })
  await reporter.dispose()
  expect(commands).toHaveLength(0)
})

test("reports optional connection and per-thread approval state, then releases in order", async () => {
  const commands: string[][] = []
  const reporter = new HerdrReporter({ paneId: "w2:p8" }, async (args) => {
    commands.push([...args])
  })
  await reporter.report({
    summary: thread,
    connection: "connected",
    pendingApprovals: 1,
  })
  await reporter.report({
    summary: thread,
    connection: "connected",
    pendingApprovals: 1,
  })
  await reporter.report({
    summary: { ...thread, status: "idle" },
    connection: "error",
    pendingApprovals: 0,
  })
  await reporter.report({ connection: "connecting" })
  await reporter.dispose()

  expect(commands).toHaveLength(9)
  expect(
    commands.every((args) => args[0] === "pane" && args[2] === "w2:p8"),
  ).toBe(true)
  expect(commands[0]).toContain("blocked")
  expect(commands[0]).toContain("thread-one")
  expect(commands[2]).toContain("approvals=1")
  expect(commands[2]).toContain("thread=thread-one")
  expect(commands[3]).toContain("unknown")
  expect(commands[5]).toContain("connection=error")
  expect(commands[6]).not.toContain("--agent-session-id")
  expect(commands[7]).toContain("connection=connecting")
  expect(commands.at(-1)?.[1]).toBe("release-agent")
})

test("does not report token-count-only metadata changes", async () => {
  const commands: string[][] = []
  const reporter = new HerdrReporter({ paneId: "w2:p9" }, async (args) => {
    commands.push([...args])
  })
  await reporter.report({
    summary: { ...thread, contextUsed: 10, contextLimit: 100 },
    connection: "connected",
  })
  await reporter.report({
    summary: { ...thread, contextUsed: 90, contextLimit: 100 },
    connection: "connected",
  })
  expect(commands).toHaveLength(3)
  await reporter.report({
    summary: {
      ...thread,
      title: "Vimex next",
      contextUsed: 90,
      contextLimit: 100,
    },
    connection: "connected",
  })
  expect(commands).toHaveLength(6)
  expect(commands[5]).toContain("context_used=90")
  await reporter.dispose()
})

test("coalesces an update burst to the in-flight and latest states", async () => {
  const commands: string[][] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reporter = new HerdrReporter({ paneId: "w1:p1" }, async (args) => {
    commands.push([...args])
    if (commands.length === 1) await gate
  })
  const first = reporter.report({ summary: thread, connection: "connected" })
  const duplicate = reporter.report({
    summary: thread,
    connection: "connected",
  })
  const replaced = reporter.report({
    summary: { ...thread, title: "intermediate" },
    connection: "connected",
  })
  const latest = reporter.report({
    summary: { ...thread, title: "latest" },
    connection: "connected",
  })

  expect(duplicate).toBe(first)
  expect(commands).toHaveLength(1)
  release()
  await Promise.all([first, duplicate, replaced, latest])
  expect(commands).toHaveLength(6)
  expect(commands[2]).toContain("Vimex")
  expect(commands[5]).toContain("latest")
  expect(commands.flat()).not.toContain("intermediate")
  await reporter.dispose()
})

test("a newer request can restore the active signature without a redundant report", async () => {
  const commands: string[][] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reporter = new HerdrReporter({ paneId: "w1:p1" }, async (args) => {
    commands.push([...args])
    if (commands.length === 1) await gate
  })
  const first = reporter.report({ summary: thread })
  void reporter.report({ summary: { ...thread, title: "superseded" } })
  void reporter.report({ summary: thread })
  release()
  await first
  expect(commands).toHaveLength(3)
  await reporter.dispose()
})

test("a failed report can be retried without poisoning later updates", async () => {
  let calls = 0
  const reporter = new HerdrReporter({ paneId: "w1:p1" }, async () => {
    if (++calls === 1) throw new Error("offline")
  })
  await expect(reporter.report({ summary: thread })).rejects.toThrow("offline")
  await reporter.report({ summary: thread })
  expect(calls).toBe(4)
  await reporter.dispose()
})

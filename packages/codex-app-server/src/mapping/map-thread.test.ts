import { expect, test } from "bun:test"
import { threadId } from "@vimex/conversation"
import type { Thread } from "../generated/v0_154_0/v2/Thread"
import { mapNotificationEvents } from "./map-notification"
import { mapThreadSummary } from "./map-thread"

const thread = (patch: Partial<Thread>): Thread =>
  ({
    id: "thread",
    cwd: "/repo",
    preview: "",
    name: null,
    model: null,
    reasoningEffort: null,
    status: { type: "idle" },
    updatedAt: 1,
    recencyAt: 1,
    parentThreadId: null,
    ...patch,
  }) as Thread

test("multiline first messages become bounded one-line session titles", () => {
  const summary = mapThreadSummary(
    thread({
      preview: `Investigate the picker\n\n${"and its sessions ".repeat(12)}`,
    }),
  )
  expect(
    summary.title.startsWith("Investigate the picker and its sessions"),
  ).toBe(true)
  expect(summary.title).not.toContain("\n")
  expect(summary.title.length).toBeLessThanOrEqual(81)
  expect(summary.title.endsWith("…")).toBe(true)
  expect(summary.titleSource).toBe("preview")
})

test("a user name wins over preview and child ancestry survives mapping", () => {
  const summary = mapThreadSummary(
    thread({
      name: "My\n  session",
      preview: "Different first message",
      parentThreadId: "parent",
      agentNickname: "reviewer",
      agentRole: "explorer",
      canAcceptDirectInput: false,
    }),
  )
  expect(summary.title).toBe("My session")
  expect(summary.titleSource).toBe("name")
  expect(summary.parentThreadId).toBe(threadId("parent"))
  expect(summary.agentNickname).toBe("reviewer")
  expect(summary.agentRole).toBe("explorer")
  expect(summary.canAcceptDirectInput).toBe(false)
})

test("thread/started retains a parent-owned child's input capability and name", () => {
  const events = mapNotificationEvents({
    method: "thread/started",
    params: {
      thread: thread({
        id: "child",
        parentThreadId: "parent",
        agentNickname: " review\n agent ",
        agentRole: " explorer ",
        canAcceptDirectInput: false,
      }),
    },
  })
  expect(events[0]).toMatchObject({
    type: "thread.summary",
    summary: {
      id: threadId("child"),
      parentThreadId: threadId("parent"),
      agentNickname: "review agent",
      agentRole: "explorer",
      canAcceptDirectInput: false,
    },
    relation: {
      threadId: threadId("child"),
      parentThreadId: threadId("parent"),
      agentNickname: "review agent",
    },
  })
  expect(events[1]).toMatchObject({
    type: "subagent.link",
    link: {
      ownerThreadId: threadId("parent"),
      agentThreadId: threadId("child"),
      relation: "spawned",
    },
  })
})

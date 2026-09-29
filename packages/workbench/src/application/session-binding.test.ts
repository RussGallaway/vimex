import { describe, expect, test } from "bun:test"
import { threadId, type ThreadSummary } from "@vimex/conversation"
import { createWorkspace, initialWorkbench } from "./workbench-state"
import { bindProvisionalWorkspace } from "./session-binding"

const summary = (id: string): ThreadSummary => ({
  id: threadId(id),
  title: id,
  model: "gpt",
  reasoningEffort: "high",
  cwd: "/tmp",
  status: "idle",
})

describe("session binding", () => {
  test("moves draft and queued messages to the real workspace", () => {
    const provisional = threadId("local")
    const real = threadId("real")
    let state = {
      ...initialWorkbench(),
      activeThreadId: provisional,
      provisionalThreadIds: [provisional],
      threadOrder: [provisional, real],
      summaries: { [provisional]: summary("local"), [real]: summary("real") },
      workspaces: {
        [provisional]: createWorkspace(provisional),
        [real]: createWorkspace(real),
      },
    }
    const provisionalWorkspace = state.workspaces[provisional]!
    state = {
      ...state,
      workspaces: {
        ...state.workspaces,
        [provisional]: {
          ...provisionalWorkspace,
          composer: {
            ...provisionalWorkspace.composer,
            text: "draft",
            outbox: [
              {
                id: "message-1",
                text: "queued",
                intent: "next-turn",
                status: "queued",
              },
            ],
          },
        },
      },
    }
    const bound = bindProvisionalWorkspace(state, provisional, real)
    expect(bound.activeThreadId).toBe(real)
    expect(bound.provisionalThreadIds).toEqual([])
    expect(bound.workspaces[provisional]).toBeUndefined()
    expect(bound.workspaces[real]?.composer.text).toBe("draft")
    expect(bound.workspaces[real]?.composer.outbox[0]?.id).toBe("message-1")
  })

  test("is idempotent after the provisional workspace has been consumed", () => {
    const provisional = threadId("local")
    const real = threadId("real")
    const state = {
      ...initialWorkbench(),
      provisionalThreadIds: [],
      workspaces: { [real]: createWorkspace(real) },
    }
    expect(bindProvisionalWorkspace(state, provisional, real)).toBe(state)
  })
})

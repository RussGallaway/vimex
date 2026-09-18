import { describe, expect, test } from "bun:test"
import { failApproval, initialApprovals, receiveApproval, resolvingApproval } from "./index"
import { threadId } from "@vimex/conversation"

describe("approvals", () => {
  test("deduplicates, resolves, and records failures", () => {
    const approval = { id: "a", threadId: threadId("t"), kind: "command" as const, title: "Run", detail: "x", choices: [{ id: "yes", label: "Yes" }], status: "pending" as const }
    let state = receiveApproval(initialApprovals(), approval)
    state = receiveApproval(state, approval)
    expect(state.order).toEqual(["a"])
    state = resolvingApproval(state, "a")
    expect(state.byId.a?.status).toBe("resolving")
    state = failApproval(state, "a", "nope")
    expect(state.byId.a).toMatchObject({ status: "failed", error: "nope" })
    expect(resolvingApproval(state, "a").byId.a).toMatchObject({ status: "resolving", error: undefined })
  })
})

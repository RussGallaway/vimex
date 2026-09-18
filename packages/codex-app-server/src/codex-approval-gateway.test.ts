import { expect, test } from "bun:test"
import { itemId, threadId, turnId } from "@vimex/conversation"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"
import { CodexApprovalGateway } from "./codex-approval-gateway"

test("old question response cannot erase a reused request ID after restart", async () => {
  let complete!: () => void
  let calls = 0
  const client = { respondToUserInput: async () => { if (++calls === 1) await new Promise<void>(resolve => { complete = resolve }) } } as unknown as CodexAppServerClient
  const gateway = new CodexApprovalGateway(() => client)
  const request = { type: "userInput.requested" as const, requestId: 1, itemId: itemId("item"), isBlocking: true, threadId: threadId("thread"), turnId: turnId("turn"), questions: [] }
  gateway.handle(request)
  const previous = gateway.respondToQuestions("number:1", {})
  gateway.invalidatePending()
  gateway.handle(request)
  complete()
  await previous
  await gateway.respondToQuestions("number:1", {})
  expect(calls).toBe(2)
})

import { expect, test } from "bun:test"
import { threadId } from "@vimex/conversation"
import { captureStartupReadiness } from "./startup-readiness"
import { initialWorkbench } from "./workbench-state"

test("startup readiness separates shell, connection, and bound session", () => {
  const id = threadId("local")
  const provisional = {
    ...initialWorkbench(),
    activeThreadId: id,
    provisionalThreadIds: [id],
  }
  expect(captureStartupReadiness(provisional)).toEqual({
    shellReady: true,
    connectionReady: false,
    sessionBound: false,
  })
  expect(
    captureStartupReadiness({
      ...provisional,
      connection: "connected",
      provisionalThreadIds: [],
    }),
  ).toEqual({ shellReady: true, connectionReady: true, sessionBound: true })
})

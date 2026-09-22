import { threadId } from "@vimex/conversation"
import { expect, test } from "bun:test"
import { mapNotification } from "./map-notification"
const goal = {
  objective: "Fix tests",
  status: "active" as const,
  tokenBudget: null,
  tokensUsed: 20,
  timeUsedSeconds: 4,
}
test("goal notifications normalize live state and reject malformed accounting", () => {
  expect(
    mapNotification({
      method: "thread/goal/updated",
      params: { threadId: "a", goal },
    }),
  ).toEqual({ type: "thread.goal", threadId: threadId("a"), goal })
  expect(
    mapNotification({
      method: "thread/goal/cleared",
      params: { threadId: "a" },
    }),
  ).toEqual({ type: "thread.goal", threadId: threadId("a"), goal: null })
  for (const bad of [
    { ...goal, status: "imaginary" },
    { ...goal, tokensUsed: -1 },
    { ...goal, tokenBudget: 0 },
    { ...goal, timeUsedSeconds: NaN },
  ])
    expect(
      mapNotification({
        method: "thread/goal/updated",
        params: { threadId: "a", goal: bad },
      }).type,
    ).toBe("unknown")
})

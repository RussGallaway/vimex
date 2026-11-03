import { expect, test } from "bun:test"
import { createCodexGateways } from "./codex-gateway"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"

function native(overrides: Record<string, unknown> = {}) {
  const client = {
    onEvent: () => () => {},
    readThread: async () => ({ thread: { parentThreadId: null } }),
    listThreads: async () => ({ raw: { data: [] }, nextCursor: null }),
    listTurns: async () => ({ data: [], nextCursor: null }),
    ...overrides,
  } as unknown as CodexAppServerClient
  return createCodexGateways("/repo", "codex", () => client).nativeHandoff
}

test("tree discovery includes archived children and collaboration references across full turn pages", async () => {
  const catalogs: Array<Record<string, unknown>> = []
  const turns: Array<Record<string, unknown>> = []
  const api = native({
    readThread: async () => ({ thread: { parentThreadId: "parent" } }),
    listThreads: async (params: Record<string, unknown>) => {
      catalogs.push(params)
      return {
        raw: {
          data: [
            {
              id: params.archived
                ? "closed-child"
                : params.cursor
                  ? "second-child"
                  : "child",
            },
          ],
        },
        nextCursor: !params.archived && !params.cursor ? "more-children" : null,
      }
    },
    listTurns: async (params: Record<string, unknown>) => {
      turns.push(params)
      return {
        data: [
          {
            items: params.cursor
              ? [
                  {
                    type: "subAgentActivity",
                    agentThreadId: "historical-child",
                  },
                ]
              : [
                  {
                    type: "collabAgentToolCall",
                    receiverThreadIds: ["child", "root"],
                    agentsStates: { "state-only-child": {} },
                  },
                ],
          },
        ],
        nextCursor: params.cursor ? null : "more-turns",
      }
    },
  })
  expect(new Set(await api.referencedThreads("root"))).toEqual(
    new Set([
      "parent",
      "child",
      "second-child",
      "closed-child",
      "state-only-child",
      "historical-child",
    ]),
  )
  expect(
    catalogs.every(
      (params) =>
        params.parentThreadId === "root" && params.useStateDbOnly === false,
    ),
  ).toBe(true)
  expect(
    turns.every(
      (params) => params.itemsView === "full" && params.sortDirection === "asc",
    ),
  ).toBe(true)
})

test("tree discovery refuses nonadvancing native catalog and turn cursors", async () => {
  const catalog = native({
    listThreads: async () => ({ raw: { data: [] }, nextCursor: "repeat" }),
  })
  await expect(catalog.referencedThreads("root")).rejects.toThrow(
    "did not advance",
  )
  const turns = native({
    listTurns: async () => ({ data: [], nextCursor: "repeat" }),
  })
  await expect(turns.referencedThreads("root")).rejects.toThrow(
    "did not advance",
  )
})

test("tree discovery bounds referenced IDs and rejects malformed native references", async () => {
  const overflowing = native({
    listThreads: async () => ({
      raw: {
        data: Array.from({ length: 65 }, (_, i) => ({ id: `child-${i}` })),
      },
    }),
  })
  await expect(overflowing.referencedThreads("root")).rejects.toThrow(
    "64-thread",
  )
  const malformed = native({
    listTurns: async () => ({
      data: [{ items: [{ type: "subAgentActivity", agentThreadId: "" }] }],
    }),
  })
  await expect(malformed.referencedThreads("root")).rejects.toThrow(
    "invalid thread reference",
  )
})

test("owned subtree lookup includes archived descendants without historical collaboration references", async () => {
  const calls: Array<Record<string, unknown>> = []
  const api = native({
    listThreads: async (params: Record<string, unknown>) => {
      calls.push(params)
      return {
        raw: {
          data: [{ id: params.archived ? "archived-grandchild" : "child" }],
        },
      }
    },
    listTurns: async () => {
      throw new Error("Historical references must not define native ownership")
    },
  })
  expect(new Set(await api.ownedDescendants("root"))).toEqual(
    new Set(["child", "archived-grandchild"]),
  )
  expect(calls.every((params) => params.ancestorThreadId === "root")).toBe(true)
})

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCodexGateways } from "./codex-gateway"
import { threadId } from "@vimex/conversation"
import type { CodexAppServerClient } from "./capabilities/codex-app-server-client"

const temporaryDirectories: string[] = []
const sessionSummary = (id: string) => ({
  id: threadId(id),
  title: id,
  cwd: "/work",
  model: "test",
  reasoningEffort: "high",
  status: "idle" as const,
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("grep mention results include hidden files and bounded file previews", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vimex-grep-"))
  temporaryDirectories.push(cwd)
  const file = join(cwd, ".env.example")
  await writeFile(file, "CODEX_TOKEN=present\n")

  const client = {
    onEvent: () => () => {},
    close: async () => {},
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways(cwd, "codex", () => client)
  const results = await gateways.conversation.searchMentions!(
    "CODEX_TOKEN",
    "grep",
    cwd,
  )

  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    kind: "file",
    path: file,
    detail: "1: CODEX_TOKEN=present",
    preview: "CODEX_TOKEN=present\n",
  })
  await gateways.connection.close()
})

test("file mention results are not truncated before the picker ranks them", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vimex-files-"))
  temporaryDirectories.push(cwd)
  const files = await Promise.all(
    Array.from({ length: 55 }, async (_, index) => {
      const path = join(cwd, `file-${index}.ts`)
      await writeFile(path, `export const value = ${index}\n`)
      return path
    }),
  )
  const client = {
    onEvent: () => () => {},
    close: async () => {},
    fuzzyFileSearch: async () => ({
      files: files.map((path) => ({
        root: cwd,
        path,
        match_type: "file" as const,
        file_name: path.split("/").at(-1)!,
        score: 0,
        indices: null,
      })),
    }),
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways(cwd, "codex", () => client)
  const results = await gateways.conversation.searchMentions!("", "file", cwd)
  expect(results).toHaveLength(55)
  expect(results.some((entry) => entry.name === files.at(-1))).toBe(true)
  await gateways.connection.close()
})

test("grep skips oversized files before reading them into memory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vimex-large-grep-"))
  temporaryDirectories.push(cwd)
  await writeFile(
    join(cwd, "large.txt"),
    `needle\n${"x".repeat(2 * 1024 * 1024)}`,
  )
  const small = join(cwd, "small.txt")
  await writeFile(small, "needle\nsmall match\n")

  const client = {
    onEvent: () => () => {},
    close: async () => {},
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways(cwd, "codex", () => client)
  const results = await gateways.conversation.searchMentions!(
    "needle",
    "grep",
    cwd,
  )

  expect(results.map((entry) => entry.path)).toEqual([small])
  await gateways.connection.close()
})

test("thread listing excludes child sessions from relation metadata", async () => {
  const parent = threadId("parent")
  const child = threadId("child")
  const summary = (id: typeof parent) => ({
    id,
    title: id,
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "idle" as const,
  })
  const client = {
    onEvent: () => () => {},
    close: async () => {},
    listThreads: async () => ({
      threads: [summary(parent), summary(child)],
      relations: [
        { threadId: parent, source: "cli" },
        { threadId: child, parentThreadId: parent, source: "subAgent" },
      ],
      nextCursor: null,
      backwardsCursor: null,
      raw: {} as never,
    }),
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways("/work", "codex", () => client)
  await expect(gateways.conversation.listThreads()).resolves.toEqual([
    summary(parent),
  ])
  await gateways.connection.close()
})

test("session pages publish before older history finishes and keep indexed cursors", async () => {
  const first = sessionSummary("first")
  const older = sessionSummary("older")
  const gate = Promise.withResolvers<void>()
  const requests: unknown[] = []
  const pages: unknown[] = []
  const client = {
    onEvent: () => () => {},
    close: async () => {},
    listThreads: async (params: { cursor?: string }) => {
      requests.push(params)
      if (params.cursor) await gate.promise
      return {
        threads: [params.cursor ? older : first],
        relations: [],
        nextCursor: params.cursor ? null : "older-page",
      }
    },
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways("/work", "codex", () => client)
  const listed = gateways.conversation.listThreads((page) => pages.push(page))
  await Promise.resolve()
  expect(pages).toEqual([[first]])
  expect(requests).toEqual([
    { cursor: undefined, limit: 25, useStateDbOnly: true },
    { cursor: "older-page", limit: 25, useStateDbOnly: true },
  ])
  gate.resolve()
  expect(await listed).toEqual([first, older])
  expect(pages).toEqual([[first], [older]])
  await gateways.connection.close()
})

test("empty session index falls back once, including for an empty store", async () => {
  for (const threads of [[], [sessionSummary("discovered")]]) {
    const requests: unknown[] = []
    const client = {
      onEvent: () => () => {},
      close: async () => {},
      listThreads: async (params: { useStateDbOnly: boolean }) => {
        requests.push(params)
        return {
          threads: params.useStateDbOnly ? [] : threads,
          relations: [],
          nextCursor: null,
        }
      },
    } as unknown as CodexAppServerClient
    const gateways = createCodexGateways("/work", "codex", () => client)
    expect(await gateways.conversation.listThreads()).toEqual(threads)
    expect(requests).toEqual([
      { cursor: undefined, limit: 25, useStateDbOnly: true },
      { cursor: undefined, limit: 25, useStateDbOnly: false },
    ])
    await gateways.connection.close()
  }
})

test("agent picker queries descendants separately from the user session catalog", async () => {
  const requests: unknown[] = []
  const child = { ...sessionSummary("child"), parentThreadId: threadId("root") }
  const client = {
    onEvent: () => () => {},
    close: async () => {},
    listThreads: async (params: { cursor?: string }) => {
      requests.push(params)
      return {
        threads: params.cursor ? [] : [child],
        nextCursor: params.cursor ? null : "next",
      }
    },
  } as unknown as CodexAppServerClient
  const gateways = createCodexGateways("/work", "codex", () => client)
  expect(
    await gateways.conversation.listAgentThreads!(threadId("root")),
  ).toEqual([child])
  expect(requests).toEqual(
    [undefined, "next"].map((cursor) => ({
      cursor,
      limit: 100,
      useStateDbOnly: true,
      sourceKinds: ["subAgentThreadSpawn"],
      ancestorThreadId: "root",
    })),
  )
  await gateways.connection.close()
})

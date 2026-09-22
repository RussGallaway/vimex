#!/usr/bin/env bun
/** Offline side-chat protocol fixture. Never launches Codex or touches real sessions. */
import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"
const trace = process.env.VIMEX_TEST_TRACE
const send = (message: unknown) =>
  process.stdout.write(JSON.stringify(message) + "\n")
const notify = (method: string, params: unknown) => send({ method, params })
const threads = new Map<string, any>()
const create = (id: string, title: string) => ({
  id,
  name: title,
  preview: "",
  model: "fixture-model",
  reasoningEffort: "high",
  cwd: process.cwd(),
  gitInfo: { branch: "side-tests", sha: null, originUrl: null },
  status: { type: "idle" },
  turns: [],
})
const main = create("side-main", "Main implementation")
threads.set(main.id, main)
const session = (thread: any) => ({
  thread,
  model: thread.model,
  modelProvider: "fixture",
  reasoningEffort: "high",
  cwd: thread.cwd,
})
let experimentalApi = false
let counter = 0,
  updates = 0
const timer = setInterval(() => {
  const turn = main.turns.at(-1) as any
  if (turn?.status !== "inProgress") return
  const item = turn.items.at(-1)
  const delta = `Parent progress ${++updates}: tests continue.\n`
  item.text += delta
  notify("item/agentMessage/delta", {
    threadId: main.id,
    turnId: turn.id,
    itemId: item.id,
    delta,
  })
}, 350)
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (trace) appendFileSync(trace, line + "\n")
  const result = (value: unknown) => send({ id: request.id, result: value })
  switch (request.method) {
    case "initialize":
      experimentalApi = request.params.capabilities?.experimentalApi === true
      result({
        userAgent: "vimex-side-fixture",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "test",
      })
      break
    case "initialized":
      break
    case "thread/list":
      result({
        data: [...threads.values()],
        nextCursor: null,
        backwardsCursor: null,
      })
      break
    case "thread/start":
      result(session(main))
      break
    case "thread/resume":
      result(session(threads.get(request.params.threadId)))
      break
    case "thread/turns/list":
      result({
        data: [...threads.get(request.params.threadId).turns]
          .reverse()
          .map((turn) => ({ ...turn, itemsView: "full" })),
        nextCursor: null,
      })
      break
    case "thread/fork": {
      if (request.params.deferGoalContinuation && !experimentalApi) {
        send({
          id: request.id,
          error: {
            code: -32600,
            message:
              "thread/fork.deferGoalContinuation requires experimentalApi capability",
          },
        })
        break
      }
      const child = create(`side-child-${++counter}`, `Side chat ${counter}`)
      child.turns = structuredClone(
        threads.get(request.params.threadId).turns,
      ).map((turn: any) => ({ ...turn, status: "completed" }))
      threads.set(child.id, child)
      result(session(child))
      break
    }
    case "thread/goal/clear":
      result({ cleared: false })
      break
    case "thread/goal/get":
      result({ goal: null })
      break
    case "thread/archive":
      threads.delete(request.params.threadId)
      result({})
      break
    case "model/list":
      result({ data: [], nextCursor: null })
      break
    case "turn/start": {
      const thread = threads.get(request.params.threadId)
      const id = `${thread.id}-turn-${thread.turns.length + 1}`
      const text =
        thread.id === main.id
          ? "Main agent is working.\n"
          : "The main agent is progressing. This side conversation stays independent.\n"
      const message = {
        type: "agentMessage",
        id: `${id}-answer`,
        text,
        phase: "commentary",
        memoryCitation: null,
      }
      const turn = {
        id,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: `${id}-user`,
            content: request.params.input,
            clientId: null,
          },
          message,
        ],
        error: null,
      }
      thread.turns.push(turn)
      thread.status = { type: "active", activeFlags: [] }
      result({ turn })
      notify("turn/started", {
        threadId: thread.id,
        turn: { ...turn, items: [] },
      })
      for (const item of turn.items)
        notify("item/started", { threadId: thread.id, turnId: id, item })
      break
    }
    case "turn/interrupt": {
      const thread = threads.get(request.params.threadId)
      const turn = thread.turns.find(
        (turn: any) => turn.id === request.params.turnId,
      )
      if (turn) {
        turn.status = "interrupted"
        notify("turn/completed", { threadId: thread.id, turn })
      }
      result({})
      break
    }
    default:
      send({
        id: request.id,
        error: {
          code: -32601,
          message: `Unhandled fixture request: ${request.method}`,
        },
      })
  }
}
clearInterval(timer)

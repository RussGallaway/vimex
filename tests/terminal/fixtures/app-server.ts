#!/usr/bin/env bun
import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"
const trace = process.env.VIMEX_TEST_TRACE
const thread = {
  id: "fixture-thread",
  name: "Terminal contract",
  preview: "",
  model: "fixture-model",
  reasoningEffort: "high",
  cwd: process.cwd(),
  gitInfo: { branch: "test-branch", sha: null, originUrl: null },
  status: { type: "idle" },
  turns: [],
}
const send = (message: unknown) =>
  process.stdout.write(JSON.stringify(message) + "\n")
const notify = (method: string, params: unknown) => send({ method, params })
const turn = {
  id: "fixture-turn",
  status: "inProgress",
  items: [],
  error: null,
}
const message = {
  type: "agentMessage",
  id: "fixture-answer",
  text: "**Verified** through the real terminal and JSONL transport.",
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (trace) appendFileSync(trace, line + "\n")
  const result = (value: unknown) => send({ id: request.id, result: value })
  switch (request.method) {
    case "initialize":
      result({
        userAgent: "vimex-fixture",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "test",
      })
      break
    case "initialized":
      break
    case "thread/list":
      result({ data: [], nextCursor: null, backwardsCursor: null })
      break
    case "thread/start":
      result({
        thread,
        model: thread.model,
        modelProvider: "fixture",
        reasoningEffort: "high",
        cwd: thread.cwd,
      })
      break
    case "turn/start":
      notify("turn/started", { threadId: thread.id, turn })
      notify("item/completed", {
        threadId: thread.id,
        turnId: turn.id,
        item: {
          type: "userMessage",
          id: "fixture-user",
          content: request.params.input,
          clientId: null,
        },
      })
      result({ turn })
      send({
        id: 77,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          threadId: thread.id,
          turnId: turn.id,
          itemId: "fixture-command",
          startedAtMs: Date.now(),
          environmentId: null,
          reason: "Terminal approval exercise",
          command: "printf fixture",
          availableDecisions: ["accept", "decline"],
        },
      })
      break
    case undefined:
      if (request.id === 77 && request.result?.decision === "accept") {
        notify("serverRequest/resolved", { threadId: thread.id, requestId: 77 })
        notify("item/started", {
          threadId: thread.id,
          turnId: turn.id,
          item: { ...message, text: "" },
        })
        notify("item/agentMessage/delta", {
          threadId: thread.id,
          turnId: turn.id,
          itemId: message.id,
          delta: message.text,
        })
        notify("item/completed", {
          threadId: thread.id,
          turnId: turn.id,
          item: message,
        })
        notify("turn/completed", {
          threadId: thread.id,
          turn: { ...turn, status: "completed" },
        })
      }
      break
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

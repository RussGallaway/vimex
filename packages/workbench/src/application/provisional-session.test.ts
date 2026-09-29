import { describe, expect, test } from "bun:test"
import { threadId, type ThreadSummary } from "@vimex/conversation"
import {
  createWorkspace,
  initialWorkbench,
  type WorkbenchState,
} from "./workbench-state"
import { transitionWorkbench } from "./reduce-workbench"

const summary = (id: string): ThreadSummary => ({
  id: threadId(id),
  title: id,
  model: "gpt",
  reasoningEffort: "high",
  cwd: "/tmp",
  status: "idle",
})

test("provisional workspaces retain a submitted message until binding", () => {
  const provisional = threadId("local-draft")
  let state: WorkbenchState = {
    ...initialWorkbench(),
    activeThreadId: provisional,
    provisionalThreadIds: [provisional],
    threadOrder: [provisional],
    summaries: { [provisional]: summary("local-draft") },
    workspaces: {
      [provisional]: createWorkspace(provisional),
    } as unknown as WorkbenchState["workspaces"],
  }
  // Build the workspace through the public reducer path.
  state = transitionWorkbench(state, {
    type: "thread.open",
    summary: summary("local-draft"),
  }).state
  state = transitionWorkbench(state, {
    type: "composer.change",
    text: "hello before Codex",
  }).state
  const result = transitionWorkbench(state, {
    type: "composer.submit",
    intent: "next-turn",
    clientMessageId: "message-1",
  })
  const workspace = result.state.workspaces[provisional]!
  expect(workspace.composer.outbox).toEqual([
    expect.objectContaining({
      id: "message-1",
      text: "hello before Codex",
      status: "queued",
    }),
  ])
  expect(result.effects).toHaveLength(0)
})

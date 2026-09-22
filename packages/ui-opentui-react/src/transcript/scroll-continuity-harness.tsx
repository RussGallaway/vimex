// Shared deterministic fixture for painted-frame regression tests and diagnostics.
import assert from "node:assert/strict"
import { TranscriptRuntime } from "@vimex/transcript"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import {
  itemId,
  threadId,
  turnId,
  type ConversationGateway,
} from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import {
  VimexController,
  type ModelCatalog,
  type RuntimeConnection,
  type RuntimeEvent,
} from "@vimex/workbench"
import { ConnectedVimexRoot } from "../index"

export const thread = threadId("wheel-thread")
export const answer = itemId("wheel-answer")
export async function wheelHarness(
  toolCount = 100,
  expanded = false,
  dense = false,
) {
  let emit: (event: RuntimeEvent) => void = () => {}
  const summary = {
    id: thread,
    title: "Wheel interaction",
    cwd: "/work",
    model: "test",
    reasoningEffort: "high",
    status: "idle" as const,
  }
  const runtime: ConversationGateway &
    ApprovalGateway &
    RuntimeConnection &
    ModelCatalog = {
    connect: async () => {},
    restart: async () => {},
    close: async () => {},
    subscribe(listener) {
      emit = listener
      return () => {
        emit = () => {}
      }
    },
    listThreads: async () => [summary],
    startThread: async () => ({ summary, events: [] }),
    resumeThread: async () => ({ summary, events: [] }),
    forkThread: async () => ({ summary, events: [] }),
    startTurn: async () => [],
    steerTurn: async () => {},
    interruptTurn: async () => {},
    updateSettings: async () => {},
    renameThread: async () => {},
    resolveApproval: async () => {},
    listModels: async () => [],
  }
  const controller = new VimexController({
    conversation: runtime,
    approvals: runtime,
    connection: runtime,
    models: runtime,
    resolveDirectory: (value) => value,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/work")
  emit({
    type: "conversation",
    event: {
      type: "item.started",
      threadId: thread,
      item: {
        id: answer,
        turnId: turnId("wheel-turn"),
        kind: "assistant",
        markdown: Array.from(
          { length: 60 },
          (_, index) => `Line ${index} readable output`,
        ).join("\n\n"),
        status: "running",
      },
    },
  })
  for (let index = 0; index < toolCount; index++)
    emit({
      type: "conversation",
      event: {
        type: "item.started",
        threadId: thread,
        item: {
          id: itemId(`scroll-command-${index}`),
          turnId: turnId("wheel-turn"),
          kind: "command",
          title: `Command ${index}`,
          detail: Array.from(
            { length: 20 },
            (_, row) => `OUTPUT ${index}:${row} deterministic tool output`,
          ).join("\n"),
          status: "complete",
        },
      },
    })
  const tailText = toolCount
    ? expanded
      ? `OUTPUT ${toolCount - 1}:19`
      : `Command ${toolCount - 1}`
    : "Line 59 readable output"
  if (expanded) controller.transcript({ type: "fold.all", folded: false })
  if (dense) {
    const workspace = controller.getSnapshot().workspaces[thread]!
    const reference = new TranscriptRuntime({
      threadId: thread,
      canonicalGeneration: workspace.canonicalGeneration,
      canonicalRevision: workspace.canonicalRevision,
      conversation: workspace.conversation,
      transcript: workspace.transcript,
      mode: "follow",
    })
    // Diagnostic-only dense reference. Prevent the UI viewport measurement from
    // enabling windowing, and register with normal controller synchronization.
    reference.setWindowViewport = () => reference.getSnapshot()
    const internals = controller as unknown as {
      transcriptRuntimes: Map<string, TranscriptRuntime>
    }
    internals.transcriptRuntimes.get("main")?.dispose()
    internals.transcriptRuntimes.set("main", reference)
  }
  function Harness() {
    return <ConnectedVimexRoot controller={controller} />
  }
  let setup!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    setup = await testRender(<Harness />, { width: 80, height: 24 })
    await setup.flush()
  })
  for (
    let count = 0;
    count < 20 && !setup.captureCharFrame().includes(tailText);
    count++
  ) {
    await act(async () => {
      await Bun.sleep(5)
      await setup.flush()
      await setup.renderOnce()
    })
  }
  assert(
    setup.captureCharFrame().includes(tailText),
    "fixture failed to reach tail",
  )
  const workspace = () => controller.getSnapshot().workspaces[thread]!
  const keys = async (value: string) => {
    await act(async () => {
      await setup.mockInput.typeText(value)
      await setup.flush()
    })
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
  }
  const close = async () => {
    await act(async () => setup.renderer.destroy())
    await controller.close()
  }
  return {
    ...setup,
    controller,
    emit: (event: RuntimeEvent) => {
      emit(event)
      void controller.settle()
    },
    workspace,
    keys,
    close,
  }
}

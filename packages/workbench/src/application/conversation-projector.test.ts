import { expect, test } from "bun:test"
import {
  createConversationStructureDiagnostics,
  itemId,
  persistentConversationTurnIds,
  threadId,
  turnId,
} from "@vimex/conversation"
import { initialWorkbench, createWorkspace } from "./workbench-state"
import { applyConversationEvent } from "./conversation-projector"

test("side-child projection misses inherited history through a logarithmic persistent membership index", () => {
  for (const inheritedCount of [100, 1_000, 10_000, 100_000]) {
    const parentId = threadId(`membership-parent-${inheritedCount}`)
    const childId = threadId(`membership-child-${inheritedCount}`)
    const localTurnId = turnId(`membership-local-turn-${inheritedCount}`)
    const localItemId = itemId(`membership-local-item-${inheritedCount}`)
    let state = {
      ...initialWorkbench(),
      workspaces: { [childId]: createWorkspace(childId) },
    }
    state = applyConversationEvent(state, {
      type: "item.started",
      threadId: childId,
      item: {
        id: localItemId,
        turnId: localTurnId,
        kind: "assistant",
        markdown: "seed",
        status: "running",
      },
    }).state
    const inheritedTurnIds = persistentConversationTurnIds(
      Array.from({ length: inheritedCount }, (_, index) =>
        turnId(`membership-inherited-turn-${inheritedCount}-${index}`),
      ),
    )
    state = {
      ...state,
      sideChats: {
        [parentId]: {
          parentId,
          threadId: childId,
          visible: true,
          maximized: false,
          inheritedTurnIds,
        },
      },
    }
    const diagnostics = createConversationStructureDiagnostics()
    const next = applyConversationEvent(
      state,
      {
        type: "item.delta",
        threadId: childId,
        itemId: localItemId,
        delta: " delta",
      },
      diagnostics,
    ).state

    expect(
      next.workspaces[childId]!.conversation.items[localItemId],
    ).toMatchObject({ markdown: "seed delta" })
    expect(
      next.workspaces[childId]!.transcript.projectionById[localItemId]?.source,
    ).toBe("seed delta")
    expect(diagnostics.conversationTurnIdSequenceNormalizations).toBe(0)
    expect(diagnostics.conversationTurnIdSequenceNormalizationVisits).toBe(0)
    expect(diagnostics.conversationTurnIdSequenceLookups).toBe(1)
    expect(
      diagnostics.conversationTurnIdSequenceLookupNodeVisits,
    ).toBeLessThanOrEqual(2 * (Math.ceil(Math.log2(inheritedCount + 1)) + 1))
  }
})

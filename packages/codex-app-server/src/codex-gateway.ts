import {
  createCodexAppServerClient,
  type CodexAppServerClient,
} from "./capabilities/codex-app-server-client"
import { CodexApprovalGateway } from "./codex-approval-gateway"
import { hydrateTurns } from "./mapping/map-item"
import {
  itemId,
  type ConversationGateway,
  type ConversationInput,
} from "@vimex/conversation"
import type { UserInput } from "./generated/v0_154_0/v2/UserInput"

function normalizeConversationInput(
  text: string,
  input?: readonly ConversationInput[],
): string | UserInput[] {
  return !input?.length
    ? text
    : input.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text, text_elements: [] }
          : { type: "localImage" as const, path: part.path },
      )
}
import type {
  RuntimeEvent,
  RuntimeConnection,
  ModelCatalog,
} from "@vimex/workbench"

/** Adapts one Codex connection to the application-owned capability ports. */
export function createCodexGateways(
  cwd: string,
  executable = "codex",
  createClient: () => CodexAppServerClient = () =>
    createCodexAppServerClient(
      { cwd, command: executable },
      { experimentalApi: true },
    ),
) {
  let client = createClient()
  let detachClient = () => {}
  let closed = false
  let restartPromise: Promise<void> | undefined
  const ephemeralSideThreads = new Set<string>()
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const publish = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event)
  }
  const approvals = new CodexApprovalGateway(() => client)

  const receive = (
    event: Parameters<Parameters<CodexAppServerClient["onEvent"]>[0]>[0],
  ) => {
    const approvalEvents = approvals.handle(event)
    if (approvalEvents) {
      for (const normalized of approvalEvents) publish(normalized)
      return
    }
    let normalized: RuntimeEvent | undefined
    switch (event.type) {
      case "subagent.link":
        normalized = {
          type: "subagent.link",
          link: {
            parentId: event.link.ownerThreadId,
            childId: event.link.agentThreadId,
            itemId: event.link.itemId,
            relation: event.link.relation,
            agentPath: event.link.agentPath,
          },
        }
        break
      case "conversation":
        normalized = event
        break
      case "compaction":
        normalized = event
        break
      case "thread.summary":
        normalized = { type: "summary", summary: event.summary }
        break
      case "thread.name":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { title: event.name, titleSource: "name" },
        }
        break
      case "thread.goal":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { goal: event.goal },
        }
        break
      case "thread.status":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { status: event.status },
        }
        break
      case "thread.tokenUsage":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { contextUsed: event.used, contextLimit: event.contextLimit },
        }
        break
      case "error":
        if (event.threadId && !event.willRetry)
          publish({
            type: "compaction",
            phase: "failed",
            threadId: event.threadId,
            turnId: event.turnId,
            error: event.message,
          })
        normalized = { type: "notice", message: event.message }
        break
      case "warning":
        normalized = { type: "notice", message: event.message }
        break
      case "connection":
        if (event.status !== "connected")
          normalized = {
            type: "disconnected",
            message: event.error ?? "Codex app server disconnected",
          }
        break
      case "unknown":
        break
      case "approval.requested":
      case "approval.resolved":
      case "approval.cancelled":
      case "userInput.requested":
        break
    }
    if (normalized) publish(normalized)
  }
  const attach = () => {
    detachClient()
    detachClient = client.onEvent(receive)
  }
  attach()

  const restart = async () => {
    if (closed) throw new Error("Codex runtime connection is closed")
    if (restartPromise) return restartPromise
    const operation = (async () => {
      publish({
        type: "disconnected",
        message: "Restarting Codex app server",
        reason: "restart",
      })
      for (const event of approvals.invalidatePending()) publish(event)
      const previous = client
      // Its intentional shutdown must not invalidate the replacement connection.
      detachClient()
      try {
        await previous.close()
      } catch (error) {
        publish({
          type: "notice",
          message: `Failed to close previous Codex app server: ${String(error)}`,
        })
      } finally {
        detachClient()
      }
      client = createClient()
      ephemeralSideThreads.clear()
      attach()
      await client.connect()
    })()
    const tracked = operation.finally(() => {
      if (restartPromise === tracked) restartPromise = undefined
    })
    restartPromise = tracked
    return tracked
  }

  const connection: RuntimeConnection = {
    connect: async () => {
      if (closed) throw new Error("Codex runtime connection is closed")
      await client.connect()
    },
    restart,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      if (closed) return
      closed = true
      await restartPromise?.catch(() => {})
      try {
        await client.close()
      } finally {
        detachClient()
        listeners.clear()
      }
    },
  }
  const observeSession = <
    T extends Awaited<ReturnType<CodexAppServerClient["resumeThread"]>>,
  >(
    session: T,
  ): T => {
    if (session.relation.parentThreadId)
      publish({
        type: "subagent.link",
        link: {
          parentId: session.relation.parentThreadId,
          childId: session.relation.threadId,
          itemId: itemId(`thread:${session.relation.threadId}`),
          relation: "spawned",
        },
      })
    return session
  }
  const conversation: ConversationGateway = {
    compactThread: (id) => client.compactThread(id),
    shellCommand: (id, command) => client.shellCommand(id, command),
    async getGoal(id) {
      const goal = await client.getGoal(id)
      publish({ type: "metadata", threadId: id, patch: { goal } })
      return goal
    },
    async setGoal(id, update) {
      const goal = await client.setGoal(id, update)
      publish({ type: "metadata", threadId: id, patch: { goal } })
      return goal
    },
    async clearGoal(id) {
      const cleared = await client.clearGoal(id)
      publish({ type: "metadata", threadId: id, patch: { goal: null } })
      return cleared
    },
    async forkSideThread(id) {
      const fork = await client.forkThread(id, undefined, {
        ephemeral: true,
        excludeTurns: true,
      })
      ephemeralSideThreads.add(fork.summary.id)
      // Ephemeral forks cannot inherit a persisted goal. Mark inherited history
      // as reference context before the first side turn.
      try {
        await client.injectItems({
          threadId: fork.summary.id,
          items: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Side conversation boundary. The inherited history is reference context only. Do not continue the parent's active task or goal. Only requests submitted after this boundary are active instructions for this side conversation.",
                },
              ],
            },
          ],
        })
      } catch (error) {
        await client.unsubscribeThread(fork.summary.id)
        ephemeralSideThreads.delete(fork.summary.id)
        throw error
      }
      return observeSession(fork)
    },
    async retireThread(id) {
      if (ephemeralSideThreads.has(id)) {
        await client.unsubscribeThread(id)
        ephemeralSideThreads.delete(id)
      } else await client.archiveThread(id)
    },
    async listThreads() {
      const all = []
      let cursor: string | undefined
      do {
        const page = await client.listThreads({ cursor, limit: 100 })
        all.push(...page.threads)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return all
    },
    async startThread(cwd, model) {
      return observeSession(
        await client.startThread({ cwd, ...(model ? { model } : {}) }),
      )
    },
    async resumeThread(id) {
      return observeSession(await client.resumeThread(id))
    },
    async forkThread(id, through) {
      return observeSession(await client.forkThread(id, through))
    },
    async startTurn(id, text, clientMessageId, input, onRequestSent) {
      const response = await client.startTurn(
        id,
        normalizeConversationInput(text, input),
        {
          clientUserMessageId: clientMessageId,
        },
        onRequestSent,
      )
      return hydrateTurns([response.turn], id)
    },
    async steerTurn(id, turn, text, clientMessageId, input, onRequestSent) {
      await client.steerTurn(
        id,
        turn,
        normalizeConversationInput(text, input),
        {
          clientUserMessageId: clientMessageId,
        },
        onRequestSent,
      )
    },
    async interruptTurn(id, turn) {
      await client.interruptTurn(id, turn)
    },
    async renameThread(id, name) {
      await client.renameThread(id, name)
    },
    async updateSettings(id, settings) {
      await client.updateThreadSettings(id, settings)
    },
  }
  const models: ModelCatalog = {
    async listModels() {
      // Keep every page on one connection, even if the runtime restarts mid-list.
      const source = client
      const all: Awaited<ReturnType<ModelCatalog["listModels"]>>[number][] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await source.listModels({ cursor, limit: 100 })
        all.push(
          ...page.models.map((model) => ({
            id: model.model,
            label: model.label,
            efforts: model.supportedReasoningEfforts.map((e) => e.effort),
          })),
        )
        cursor = page.nextCursor ?? undefined
        if (cursor && seen.has(cursor))
          throw new Error(
            "Codex model catalog returned a repeated pagination cursor",
          )
        if (cursor) seen.add(cursor)
      } while (cursor)
      return all
    },
  }
  return { connection, conversation, approvals, models }
}

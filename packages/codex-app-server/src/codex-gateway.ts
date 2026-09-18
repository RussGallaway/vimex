import { createCodexAppServerClient } from "./capabilities/codex-app-server-client"
import { CodexApprovalGateway } from "./codex-approval-gateway"
import { hydrateTurns } from "./mapping/map-item"
import type { ConversationGateway } from "@vimex/conversation"
import type { RuntimeEvent, RuntimeConnection, ModelCatalog } from "@vimex/workbench"

/** Adapts one Codex connection to the application-owned capability ports. */
export function createCodexGateways(cwd: string, executable = "codex") {
  const client = createCodexAppServerClient({ cwd, command: executable })
  const approvals = new CodexApprovalGateway(client)
  const connection: RuntimeConnection = {
    connect: async () => { await client.connect() },
    subscribe(listener) {
      return client.onEvent(event => {
        const approvalEvents = approvals.handle(event)
        if (approvalEvents) { for (const normalized of approvalEvents) listener(normalized); return }
        let normalized: RuntimeEvent | undefined
        switch (event.type) {
          case "subagent.link": normalized = { type: "subagent.link", link: { parentId: event.link.ownerThreadId, childId: event.link.agentThreadId, itemId: event.link.itemId, relation: event.link.relation, agentPath: event.link.agentPath } }; break
          case "conversation": normalized = event; break
          case "thread.summary": normalized = { type: "summary", summary: event.summary }; break
          case "thread.status": normalized = { type: "metadata", threadId: event.threadId, patch: { status: event.status } }; break
          case "thread.tokenUsage": normalized = { type: "metadata", threadId: event.threadId, patch: { contextUsed: event.used, contextLimit: event.contextLimit } }; break
          case "warning": case "error": normalized = { type: "notice", message: event.message }; break
          case "connection": if (event.status !== "connected") normalized = { type: "disconnected", message: event.error ?? "Codex app server disconnected" }; break
          case "unknown": break
          case "approval.requested": case "approval.resolved": case "approval.cancelled": case "userInput.requested": break
        }
        if (normalized) listener(normalized)
      })
    },
    close: () => client.close(),
  }
  const conversation: ConversationGateway = {
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
    startThread: (cwd, model) => client.startThread({ cwd, ...(model ? { model } : {}) }),
    resumeThread: id => client.resumeThread(id),
    forkThread: (id, through) => client.forkThread(id, through),
    async startTurn(id, text, clientMessageId) {
      const response = await client.startTurn(id, text, { clientUserMessageId: clientMessageId })
      return hydrateTurns([response.turn], id)
    },
    async steerTurn(id, turn, text, clientMessageId) { await client.steerTurn(id, turn, text, { clientUserMessageId: clientMessageId }) },
    async interruptTurn(id, turn) { await client.interruptTurn(id, turn) },
    async renameThread(id, name) { await client.renameThread(id, name) },
    async updateSettings(id, settings) { await client.updateThreadSettings(id, settings) },
  }
  const models: ModelCatalog = {
    async listModels() {
      const result = await client.listModels()
      return result.models.map(model => ({ id: model.model, label: model.label, efforts: model.supportedReasoningEfforts.map(e => e.effort) }))
    },
  }
  return { connection, conversation, approvals, models }
}

import { itemId, threadId, turnId, type ConversationEvent, type ThreadSummary } from "@vimex/conversation"
import type { SessionSnapshot, ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeEvent, RuntimeConnection, ModelCatalog } from "@vimex/workbench"

/** Deterministic offline exercise of the same application port as Codex. */
export function createDemoGateway(): ConversationGateway & ApprovalGateway & RuntimeConnection & ModelCatalog {
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const summary: ThreadSummary = { id: threadId("demo"), title: "Ember Tide · a quiet place to think", cwd: process.cwd(), gitBranch: "main", model: "demo", reasoningEffort: "high", contextUsed: 12400, contextLimit: 200000, status: "idle" }
  const history: ConversationEvent[] = []
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event) }
  const add = (event: ConversationEvent) => { history.push(event); emit({ type: "conversation", event }) }
  const snapshot = (): SessionSnapshot => ({ summary, events: [...history] })
  const welcome = turnId("welcome")
  history.push({ type: "turn.started", threadId: summary.id, turnId: welcome })
  history.push({ type: "item.completed", threadId: summary.id, item: { id: itemId("welcome-message"), turnId: welcome, kind: "assistant", status: "complete", markdown: "# Welcome to Vimex\n\nA quiet workspace for **Codex**, with Vim at your fingertips.\n\n- Press `i` to compose a message.\n- Press `Esc` to return to Normal mode.\n- Use `Ctrl-u` / `Ctrl-d` to explore the transcript.\n- Press `v` to select, then `y` to copy.\n\nVisit [OpenTUI](https://opentui.com) with `gx`.\n\n```typescript\nconst focus = \"one thing at a time\"\n```" } })
  history.push({ type: "turn.completed", threadId: summary.id, turnId: welcome, outcome: "complete" })
  return {
    connect: async () => {}, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    listThreads: async () => [summary], startThread: async () => snapshot(), resumeThread: async () => snapshot(),
    forkThread: async () => { throw new Error("Forking requires a live Codex thread") },
    async startTurn(id, text) {
      const turn = turnId(crypto.randomUUID()), answer = itemId(crypto.randomUUID())
      add({ type: "turn.started", threadId: id, turnId: turn })
      add({ type: "item.completed", threadId: id, item: { id: itemId(crypto.randomUUID()), turnId: turn, kind: "user", markdown: text, status: "complete" } })
      add({ type: "item.started", threadId: id, item: { id: answer, turnId: turn, kind: "assistant", markdown: "", status: "running" } })
      const output = `## A little room to think\n\nYou wrote: ${text}\n\n${Array.from({ length: 8 }, (_, i) => `### Observation ${i + 1}\n\nKeep reading here while the response grows. The composer stays at the bottom; your place in the transcript belongs to you.\n\n`).join("")}Visit [the OpenTUI documentation](https://opentui.com/docs/) whenever you are ready.`
      let offset = 0
      const timer = setInterval(() => {
        const chunk = output.slice(offset, offset + 24); offset += chunk.length
        add({ type: "item.delta", threadId: id, itemId: answer, delta: chunk })
        if (offset >= output.length) {
          clearInterval(timer); timers.delete(timer)
          add({ type: "item.completed", threadId: id, item: { id: answer, turnId: turn, kind: "assistant", markdown: output, status: "complete" } })
          add({ type: "turn.completed", threadId: id, turnId: turn, outcome: "complete" })
        }
      }, 25)
      timers.add(timer)
      return []
    },
    steerTurn: async () => { throw new Error("Steering requires a live Codex thread") },
    async interruptTurn(id, turn) { for (const timer of timers) clearInterval(timer); timers.clear(); add({ type: "turn.completed", threadId: id, turnId: turn, outcome: "interrupted" }) },
    resolveApproval: async () => {}, renameThread: async (_, name) => { summary.title = name; emit({ type: "summary", summary: { ...summary } }) },
    listModels: async () => [{ id: "demo", label: "Offline demonstration", efforts: ["low", "medium", "high"] }],
    async updateSettings(_, settings) {
      if (settings.model) summary.model = settings.model
      if (settings.effort) summary.reasoningEffort = settings.effort
      if (settings.cwd) summary.cwd = settings.cwd
      emit({ type: "summary", summary: { ...summary } })
    },
    async close() { for (const timer of timers) clearInterval(timer); timers.clear() },
  }
}

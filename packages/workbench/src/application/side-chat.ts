import { referenceText, type TranscriptState } from "@vimex/transcript"
import {
  persistentConversationTurnIds,
  type ThreadId,
  type TurnId,
  type SessionSnapshot,
} from "@vimex/conversation"
import type { WorkbenchState } from "./workbench-state"
export interface SideChat {
  parentId: ThreadId
  threadId?: ThreadId
  visible: boolean
  maximized: boolean
  status?: "creating" | "quitting"
  contextLabel?: string
  /** Retained as model context, omitted from the side transcript. */
  inheritedTurnIds?: readonly TurnId[]
  /** Ephemeral server forks are available only during this app-server lifetime. */
  ephemeral?: boolean
}
export type SideChatAction =
  | "open"
  | "close"
  | "quit"
  | "refresh"
  | "maximize"
  | "reset"
  | "parent"
  | "side"
  | "cycle"
  | "quote"

interface SideChatIndex {
  readonly any: ReadonlyMap<ThreadId, SideChat>
  readonly child: ReadonlyMap<ThreadId, SideChat>
}

const sideChatIndexes = new WeakMap<
  WorkbenchState["sideChats"],
  SideChatIndex
>()

function sideChatIndex(state: WorkbenchState): SideChatIndex {
  const cached = sideChatIndexes.get(state.sideChats)
  if (cached) return cached
  const any = new Map<ThreadId, SideChat>(),
    child = new Map<ThreadId, SideChat>()
  for (const side of Object.values(state.sideChats)) {
    if (!any.has(side.parentId)) any.set(side.parentId, side)
    if (side.threadId) {
      if (!any.has(side.threadId)) any.set(side.threadId, side)
      if (!child.has(side.threadId)) child.set(side.threadId, side)
    }
  }
  const index = { any, child }
  sideChatIndexes.set(state.sideChats, index)
  return index
}

/** Immutable side-chat records receive one disposable relationship index. */
export function sideChatForThread(
  state: WorkbenchState,
  threadId: ThreadId | undefined,
): SideChat | undefined {
  if (!threadId) return undefined
  return sideChatIndex(state).any.get(threadId)
}

/** Child-role lookup remains unambiguous when one thread also owns a side chat. */
export function sideChatForChild(
  state: WorkbenchState,
  threadId: ThreadId | undefined,
): SideChat | undefined {
  if (!threadId) return undefined
  return sideChatIndex(state).child.get(threadId)
}

export function currentSideChat(state: WorkbenchState): SideChat | undefined {
  return sideChatForThread(state, state.activeThreadId)
}
export function visibleSideChat(state: WorkbenchState): SideChat | undefined {
  const side = currentSideChat(state)
  return side?.visible ? side : undefined
}
interface SideChatHost {
  state(): WorkbenchState
  update(side: SideChat): void
  remove(parent: ThreadId, retired: ThreadId): void
  discard(parent: ThreadId): void
  focus(id: ThreadId): Promise<void> | void
  hydrate(snapshot: SessionSnapshot): void
  fork(parent: ThreadId): Promise<SessionSnapshot>
  retire(id: ThreadId): Promise<void>
  send(id: ThreadId, text: string): void
  quote(id: ThreadId, text: string): void
  presentedTranscript(id: ThreadId): TranscriptState | undefined
  notice(message: string): void
  launch(operation: () => Promise<void>): void
}
/** UI visibility and server lifetime are deliberately independent. */
export class SideChatCoordinator {
  private pendingQuestions = new Map<ThreadId, string[]>()
  constructor(private readonly host: SideChatHost) {}
  action(action: SideChatAction, question?: string): void {
    const state = this.host.state()
    const active = state.activeThreadId
    if (!active) return
    let side = currentSideChat(state)
    if (action === "open") {
      if (side?.status === "quitting") {
        this.host.notice("Side chat is quitting")
        return
      }
      if (side) {
        this.host.update({ ...side, visible: true })
        if (side.threadId) {
          const id = side.threadId
          const focus = this.host.focus(id)
          if (question?.trim())
            this.host.launch(async () => {
              await focus
              const current = this.host.state().sideChats[side!.parentId]
              if (
                current?.threadId === id &&
                current.status !== "quitting" &&
                this.host.state().connection === "connected"
              )
                this.host.send(id, question.trim())
            })
        } else if (question?.trim())
          this.pendingQuestions.set(side.parentId, [
            ...(this.pendingQuestions.get(side.parentId) ?? []),
            question.trim(),
          ])
        return
      }
      side = {
        parentId: active,
        visible: true,
        maximized: false,
        ephemeral: true,
        status: "creating",
        contextLabel: state.summaries[active]?.title ?? active,
      }
      this.host.update(side)
      this.pendingQuestions.set(
        active,
        question?.trim() ? [question.trim()] : [],
      )
      this.host.launch(async () => {
        try {
          const snapshot = await this.host.fork(active)
          const current = this.host.state().sideChats[active]
          if (!current) return
          const inheritedTurnIds = persistentConversationTurnIds([
            ...new Set([
              ...(state.workspaces[active]?.conversation.turnIds ?? []),
              ...snapshot.events.flatMap((event) =>
                "turnId" in event
                  ? [event.turnId]
                  : "item" in event
                    ? [event.item.turnId]
                    : [],
              ),
            ]),
          ])
          const ready = {
            ...current,
            inheritedTurnIds,
            threadId: snapshot.summary.id,
            status:
              current.status === "quitting" ? ("quitting" as const) : undefined,
          }
          this.host.update(ready)
          this.host.hydrate(snapshot)
          if (current.status === "quitting") {
            await this.retire(ready)
            return
          }
          if (current.visible && this.host.state().activeThreadId === active)
            this.host.focus(snapshot.summary.id)
          for (const text of this.pendingQuestions.get(active) ?? [])
            this.host.send(snapshot.summary.id, text)
        } catch (error) {
          const current = this.host.state().sideChats[active]
          if (current && !current.threadId) this.host.discard(active)
          throw error
        } finally {
          this.pendingQuestions.delete(active)
        }
      })
      return
    }
    if (!side) {
      this.host.notice("No side chat for this session")
      return
    }
    if (action === "close") {
      this.host.update({ ...side, visible: false, maximized: false })
      if (active === side.threadId) this.host.focus(side.parentId)
    } else if (action === "quit") {
      if (side.status === "quitting") return
      this.pendingQuestions.delete(side.parentId)
      this.host.update({ ...side, status: "quitting" })
      if (side.threadId) this.host.launch(() => this.retire(side!))
    } else if (action === "maximize" || action === "reset")
      this.host.update({
        ...side,
        maximized: action === "maximize" ? !side.maximized : false,
      })
    else if (action === "parent") this.host.focus(side.parentId)
    else if (action === "side" || action === "cycle") {
      const target =
        action === "cycle" && active === side.threadId
          ? side.parentId
          : side.threadId
      if (target) this.host.focus(target)
    } else if (action === "quote" && side.threadId) {
      const transcript = this.host.presentedTranscript(side.threadId)
      const text = transcript && referenceText(transcript)
      if (!text) {
        this.host.notice(
          "Select text or place the side transcript cursor on a block to quote",
        )
        return
      }
      this.host.quote(side.parentId, text)
      this.host.focus(side.parentId)
    } else if (action === "refresh" && side.threadId) {
      const workspace = state.workspaces[side.parentId]
      const latest =
        workspace?.transcript.order
          .slice(-50)
          .map((id) => workspace.transcript.projectionById[id]?.source ?? "")
          .join("\n\n")
          .slice(-48_000) ?? ""
      this.host.send(
        side.threadId,
        `Latest parent activity (a snapshot, not live context):\n\n${latest}`,
      )
      this.host.update({ ...side, contextLabel: "Updated parent activity" })
    }
  }
  private async retire(side: SideChat): Promise<void> {
    const id = side.threadId!
    try {
      await this.host.retire(id)
      if (this.host.state().activeThreadId === id)
        await this.host.focus(side.parentId)
      this.host.remove(side.parentId, id)
    } catch (error) {
      const current = this.host.state().sideChats[side.parentId]
      if (current) this.host.update({ ...current, status: undefined })
      throw error
    }
  }
}

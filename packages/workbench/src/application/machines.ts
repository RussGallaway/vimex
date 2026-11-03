import type { ConversationGateway } from "@vimex/conversation"
import type { ApprovalGateway } from "@vimex/approvals"
import type { RuntimeConnection } from "./runtime-connection"
import type { ModelCatalog } from "./model-catalog"
import type { LocalState } from "./local-state"

export interface MachineInfo {
  id: string
  label?: string
  favorite?: boolean
}
/** A prepared connection. Opening it must not destroy the source runtime. */
export interface MachineRuntime {
  machine: MachineInfo
  conversation: ConversationGateway
  approvals: ApprovalGateway
  connection: RuntimeConnection
  models: ModelCatalog
  cwd: string
  resolveDirectory?(base: string, path: string): string
  localState?: LocalState
  commit?(): Promise<void>
  rollback?(): Promise<void>
}
export interface MachineNavigation {
  current: MachineInfo
  list(): readonly MachineInfo[]
  open(id: string): Promise<MachineRuntime>
  add?(input: { id: string; sshHost: string }): Promise<void>
  rename?(id: string, label: string): Promise<void>
  remove?(id: string): Promise<void>
  setFavorite?(id: string, value: boolean): Promise<void>
  /** Must preserve native history or reject; a summary is not a handoff. */
  handoff?(input: {
    sourceId: string
    targetId: string
    threadId: string
    cwd: string
  }): Promise<MachineRuntime & { threadId: string }>
}

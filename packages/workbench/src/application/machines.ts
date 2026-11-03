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
export type HandoffPhase = "checking" | "preparing" | "restoring" | "switching"
export interface HandoffDestination {
  cwd: string
  label: string
  kind: "worktree" | "directory"
  branch?: string
  dirty?: boolean
  recent?: boolean
  favorite?: boolean
}
export interface HandoffDestinationListing {
  directory: string
  parent?: string
  entries: readonly HandoffDestination[]
  preferredCwd?: string
}
export interface HandoffDestinationQuery {
  sourceId: string
  targetId: string
  cwd: string
  directory?: string
}
/** A prepared connection. Opening it must not destroy the source runtime. */
export interface MachineRuntime {
  machine: MachineInfo
  conversation: ConversationGateway
  approvals: ApprovalGateway
  connection: RuntimeConnection
  models: ModelCatalog
  cwd: string
  directories?: import("./directories").DirectoryNavigation
  resolveDirectory?(base: string, path: string): string
  localState?: LocalState
  commit?(): Promise<void>
  rollback?(): Promise<void>
}
export interface MachineNavigation {
  current: MachineInfo
  list(): readonly MachineInfo[]
  open(id: string, cwdOverride?: string): Promise<MachineRuntime>
  add?(input: { id: string; sshHost: string }): Promise<void>
  rename?(id: string, label: string): Promise<void>
  remove?(id: string): Promise<void>
  setFavorite?(id: string, value: boolean): Promise<void>
  listHandoffDestinations?(
    input: HandoffDestinationQuery,
  ): Promise<HandoffDestinationListing>
  setHandoffDestinationFavorite?(
    input: HandoffDestinationQuery & {
      destinationCwd: string
      favorite: boolean
    },
  ): Promise<void>
  /** Read-only source eligibility check before destination selection. */
  preflightHandoff?(input: {
    sourceId: string
    targetId: string
    threadId: string
    cwd: string
  }): Promise<void>
  /** Must preserve native history or reject; a summary is not a handoff. */
  handoff?(input: {
    sourceId: string
    targetId: string
    threadId: string
    cwd: string
    destinationCwd?: string
    /** Create a fresh worktree using destinationCwd as the repository base. */
    isolated?: boolean
    onProgress?(phase: HandoffPhase): void
  }): Promise<MachineRuntime & { threadId: string }>
}

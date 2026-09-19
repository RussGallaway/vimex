import type { ItemId, TurnId } from "./identifiers"

export interface Turn {
  id: TurnId
  status: "running" | "complete" | "failed" | "interrupted"
  itemIds: readonly ItemId[]
  /** Unix time in milliseconds, when observed from the runtime. */
  startedAt?: number
  /** Unix time in milliseconds, when observed from the runtime. */
  completedAt?: number
  /** Runtime-observed duration. Never inferred from a local animation tick. */
  durationMs?: number
}

import type { ItemId, TurnId } from "./identifiers"
export interface Turn { id: TurnId; status: "running" | "complete" | "failed" | "interrupted"; itemIds: readonly ItemId[] }

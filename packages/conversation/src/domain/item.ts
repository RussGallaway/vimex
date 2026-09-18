import type { ItemId, TurnId } from "./identifiers"
export type ItemStatus = "running" | "complete" | "error" | "interrupted"
export type ConversationItem = { durationMs?: number } & (
  | { id: ItemId; turnId: TurnId; kind: "user" | "assistant" | "reasoning"; markdown: string; status: ItemStatus }
  | { id: ItemId; turnId: TurnId; kind: "command" | "tool"; title: string; detail: string; status: ItemStatus }
  | { id: ItemId; turnId: TurnId; kind: "edit"; title: string; patch: string; status: ItemStatus }
  | { id: ItemId; turnId: TurnId; kind: "unknown"; title: string; detail: string; status: ItemStatus })

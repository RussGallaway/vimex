export type Brand<T, B extends string> = T & { readonly __brand: B }
export type ThreadId = Brand<string, "ThreadId">
export type TurnId = Brand<string, "TurnId">
export type ItemId = Brand<string, "ItemId">
export const threadId = (value: string) => value as ThreadId
export const turnId = (value: string) => value as TurnId
export const itemId = (value: string) => value as ItemId

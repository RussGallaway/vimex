import type { ConversationItem } from "./item"

interface ItemNode {
  readonly key: string
  readonly value: ConversationItem
  readonly ordinal: number
  readonly height: number
  readonly left?: ItemNode
  readonly right?: ItemNode
}

interface ItemRecordData {
  readonly token: object
  readonly root?: ItemNode
  readonly size: number
  readonly nextOrdinal: number
  readonly lineage?: {
    readonly previousRoot?: ItemNode
    readonly previousSize: number
    readonly previousToken: object
    readonly updatedKey: string
    readonly previousValue?: ConversationItem
    readonly updatedValue: ConversationItem
  }
}

export interface ConversationItemRecordDiagnostics {
  conversationItemRecordNormalizations: number
  conversationItemRecordNormalizationItemVisits: number
  conversationItemRecordLookups: number
  conversationItemRecordLookupNodeVisits: number
  conversationItemRecordUpdates: number
  conversationItemRecordNodeVisits: number
  conversationItemRecordNodesCopied: number
}

const itemRecordData = new WeakMap<object, ItemRecordData>()
const normalizedItemRecords = new WeakMap<object, Readonly<Record<string, ConversationItem>>>()

const nodeHeight = (node: ItemNode | undefined) => node?.height ?? 0

function itemNode(key: string, value: ConversationItem, ordinal: number, left?: ItemNode, right?: ItemNode): ItemNode {
  return Object.freeze({
    key,
    value,
    ordinal,
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}

function copiedItemNode(
  key: string,
  value: ConversationItem,
  ordinal: number,
  left: ItemNode | undefined,
  right: ItemNode | undefined,
  diagnostics: ConversationItemRecordDiagnostics | undefined,
): ItemNode {
  if (diagnostics) diagnostics.conversationItemRecordNodesCopied += 1
  return itemNode(key, value, ordinal, left, right)
}

function rotateLeft(root: ItemNode, diagnostics?: ConversationItemRecordDiagnostics): ItemNode {
  const right = root.right!
  return copiedItemNode(right.key, right.value, right.ordinal,
    copiedItemNode(root.key, root.value, root.ordinal, root.left, right.left, diagnostics), right.right, diagnostics)
}

function rotateRight(root: ItemNode, diagnostics?: ConversationItemRecordDiagnostics): ItemNode {
  const left = root.left!
  return copiedItemNode(left.key, left.value, left.ordinal, left.left,
    copiedItemNode(root.key, root.value, root.ordinal, left.right, root.right, diagnostics), diagnostics)
}

function balance(root: ItemNode, diagnostics?: ConversationItemRecordDiagnostics): ItemNode {
  const delta = nodeHeight(root.left) - nodeHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateRight(nodeHeight(left.left) < nodeHeight(left.right)
      ? copiedItemNode(root.key, root.value, root.ordinal, rotateLeft(left, diagnostics), root.right, diagnostics)
      : root, diagnostics)
  }
  if (delta < -1) {
    const right = root.right!
    return rotateLeft(nodeHeight(right.right) < nodeHeight(right.left)
      ? copiedItemNode(root.key, root.value, root.ordinal, root.left, rotateRight(right, diagnostics), diagnostics)
      : root, diagnostics)
  }
  return root
}

function itemValue(
  root: ItemNode | undefined,
  key: string,
  diagnostics?: ConversationItemRecordDiagnostics,
): ConversationItem | undefined {
  while (root) {
    if (diagnostics) diagnostics.conversationItemRecordLookupNodeVisits += 1
    if (key === root.key) return root.value
    root = key < root.key ? root.left : root.right
  }
  return undefined
}

function setItemNode(
  root: ItemNode | undefined,
  key: string,
  value: ConversationItem,
  ordinal: number,
  diagnostics?: ConversationItemRecordDiagnostics,
): { readonly root: ItemNode; readonly added: boolean; readonly changed: boolean; readonly previousValue?: ConversationItem } {
  if (diagnostics) diagnostics.conversationItemRecordNodeVisits += 1
  if (!root) return { root: copiedItemNode(key, value, ordinal, undefined, undefined, diagnostics), added: true, changed: true }
  if (key === root.key) {
    if (root.value === value) return { root, added: false, changed: false, previousValue: root.value }
    return { root: copiedItemNode(key, value, root.ordinal, root.left, root.right, diagnostics),
      added: false, changed: true, previousValue: root.value }
  }
  if (key < root.key) {
    const next = setItemNode(root.left, key, value, ordinal, diagnostics)
    if (!next.changed) return { root, added: false, changed: false, previousValue: next.previousValue }
    return {
      root: balance(copiedItemNode(root.key, root.value, root.ordinal, next.root, root.right, diagnostics), diagnostics),
      added: next.added,
      changed: true,
      previousValue: next.previousValue,
    }
  }
  const next = setItemNode(root.right, key, value, ordinal, diagnostics)
  if (!next.changed) return { root, added: false, changed: false }
  return {
    root: balance(copiedItemNode(root.key, root.value, root.ordinal, root.left, next.root, diagnostics), diagnostics),
    added: next.added,
    changed: true,
    previousValue: next.previousValue,
  }
}

interface ItemEntry { readonly key: string; readonly value: ConversationItem; readonly ordinal: number }

function entries(root: ItemNode | undefined, result: ItemEntry[]): void {
  if (!root) return
  entries(root.left, result)
  result.push({ key: root.key, value: root.value, ordinal: root.ordinal })
  entries(root.right, result)
}

function ordinaryRecordKeys(values: readonly ItemEntry[]): string[] {
  const indexed: number[] = []
  const named: ItemEntry[] = []
  for (const entry of values) {
    const { key } = entry
    const value = Number(key)
    if (Number.isInteger(value) && value >= 0 && value < 0xffff_ffff && String(value) === key) indexed.push(value)
    else named.push(entry)
  }
  indexed.sort((left, right) => left - right)
  named.sort((left, right) => left.ordinal - right.ordinal)
  return [...indexed.map(String), ...named.map(entry => entry.key)]
}

function itemRecord(data: ItemRecordData): Readonly<Record<string, ConversationItem>> {
  const target = Object.create(null) as Record<string, ConversationItem>
  const proxy = new Proxy(target, {
    get: (_target, property) => typeof property === "string" ? itemValue(data.root, property) : Reflect.get(target, property),
    has: (_target, property) => typeof property === "string" ? itemValue(data.root, property) !== undefined : false,
    ownKeys: () => { const values: ItemEntry[] = []; entries(data.root, values); return ordinaryRecordKeys(values) },
    getOwnPropertyDescriptor: (_target, property) => typeof property === "string" && itemValue(data.root, property) !== undefined
      ? { configurable: true, enumerable: true, writable: false, value: itemValue(data.root, property) }
      : undefined,
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  itemRecordData.set(proxy, data)
  return proxy
}

/** Normalize persisted/plain canonical items into an immutable path-copying record. */
export function persistentConversationItems(
  value: Readonly<Record<string, ConversationItem>> = {},
  diagnostics?: ConversationItemRecordDiagnostics,
): Readonly<Record<string, ConversationItem>> {
  if (itemRecordData.has(value)) return value
  const cached = normalizedItemRecords.get(value)
  if (cached) return cached
  const sourceEntries = Object.entries(value)
  if (diagnostics) {
    diagnostics.conversationItemRecordNormalizations += 1
    diagnostics.conversationItemRecordNormalizationItemVisits += sourceEntries.length
  }
  const values = sourceEntries.map(([key, item], ordinal) => ({ key, item, ordinal }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  const build = (from: number, to: number): ItemNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const { key, item, ordinal } = values[middle]!
    return itemNode(key, item, ordinal, build(from, middle), build(middle + 1, to))
  }
  const record = itemRecord({ token: Object.freeze({}), root: build(0, values.length), size: values.length, nextOrdinal: values.length })
  normalizedItemRecords.set(value, record)
  return record
}

export function setConversationItem(
  value: Readonly<Record<string, ConversationItem>>,
  item: ConversationItem,
  diagnostics?: ConversationItemRecordDiagnostics,
): Readonly<Record<string, ConversationItem>> {
  const record = persistentConversationItems(value, diagnostics)
  const data = itemRecordData.get(record)!
  const next = setItemNode(data.root, item.id, item, data.nextOrdinal, diagnostics)
  if (!next.changed) return record
  if (diagnostics) diagnostics.conversationItemRecordUpdates += 1
  return itemRecord({
    token: Object.freeze({}),
    root: next.root,
    size: data.size + (next.added ? 1 : 0),
    nextOrdinal: data.nextOrdinal + (next.added ? 1 : 0),
    lineage: {
      previousRoot: data.root,
      previousSize: data.size,
      previousToken: data.token,
      updatedKey: item.id,
      previousValue: next.previousValue,
      updatedValue: item,
    },
  })
}

/** Observable lookup used by scaling evidence; normal property access remains the public Record API. */
export function conversationItemAt(
  value: Readonly<Record<string, ConversationItem>>,
  itemId: string,
  diagnostics?: ConversationItemRecordDiagnostics,
): ConversationItem | undefined {
  const data = itemRecordData.get(value)
  if (diagnostics) diagnostics.conversationItemRecordLookups += 1
  if (!data) return Object.hasOwn(value, itemId) ? value[itemId] : undefined
  return itemValue(data.root, itemId, diagnostics)
}

export function isConversationItemUpdate(
  previous: Readonly<Record<string, ConversationItem>>,
  next: Readonly<Record<string, ConversationItem>>,
  itemId: string,
  previousItem: ConversationItem | undefined,
  nextItem: ConversationItem,
): boolean {
  const data = itemRecordData.get(next)
  const previousData = itemRecordData.get(previous)
  return data?.lineage !== undefined && previousData !== undefined
    && data.lineage.previousRoot === previousData.root && data.lineage.previousSize === previousData.size
    && data.lineage.previousToken === previousData.token
    && data.lineage.updatedKey === itemId && data.lineage.previousValue === previousItem && data.lineage.updatedValue === nextItem
    && data.size === previousData.size + (previousItem ? 0 : 1)
}

export function isConversationItemAddition(
  previous: Readonly<Record<string, ConversationItem>>,
  next: Readonly<Record<string, ConversationItem>>,
  item: ConversationItem,
): boolean {
  return isConversationItemUpdate(previous, next, item.id, undefined, item)
}

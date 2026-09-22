import type { Turn } from "./turn"
import {
  isTurnItemIdAppend,
  persistentTurnItemIds,
  type ConversationStructureDiagnostics,
} from "./conversation-id-sequences"
import type { ItemId } from "./identifiers"

interface TurnNode {
  readonly key: string
  readonly value: Turn
  readonly ordinal: number
  readonly height: number
  readonly left?: TurnNode
  readonly right?: TurnNode
}

interface TurnRecordLineage {
  readonly previousRoot?: TurnNode
  readonly previousSize: number
  readonly previousToken: object
  readonly updatedKey: string
  readonly previousValue?: Turn
  readonly updatedValue: Turn
}

interface TurnRecordData {
  readonly token: object
  readonly root?: TurnNode
  readonly size: number
  readonly nextOrdinal: number
  readonly lineage?: TurnRecordLineage & { readonly prior?: TurnRecordLineage }
}
interface TurnEntry {
  readonly key: string
  readonly value: Turn
  readonly ordinal: number
}
type StructureDiagnostics = Partial<ConversationStructureDiagnostics>

const turnRecordData = new WeakMap<object, TurnRecordData>()
const normalizedTurnRecords = new WeakMap<
  object,
  Readonly<Record<string, Turn>>
>()

function bump(
  diagnostics: StructureDiagnostics | undefined,
  key: keyof ConversationStructureDiagnostics,
  amount = 1,
): void {
  if (diagnostics) diagnostics[key] = (diagnostics[key] ?? 0) + amount
}

const nodeHeight = (node: TurnNode | undefined) => node?.height ?? 0

function turnNode(
  key: string,
  value: Turn,
  ordinal: number,
  left?: TurnNode,
  right?: TurnNode,
): TurnNode {
  return Object.freeze({
    key,
    value,
    ordinal,
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}

function copiedTurnNode(
  key: string,
  value: Turn,
  ordinal: number,
  left: TurnNode | undefined,
  right: TurnNode | undefined,
  diagnostics?: StructureDiagnostics,
): TurnNode {
  bump(diagnostics, "conversationTurnRecordNodesCopied")
  return turnNode(key, value, ordinal, left, right)
}

function rotateLeft(
  root: TurnNode,
  diagnostics?: StructureDiagnostics,
): TurnNode {
  const right = root.right!
  return copiedTurnNode(
    right.key,
    right.value,
    right.ordinal,
    copiedTurnNode(
      root.key,
      root.value,
      root.ordinal,
      root.left,
      right.left,
      diagnostics,
    ),
    right.right,
    diagnostics,
  )
}

function rotateRight(
  root: TurnNode,
  diagnostics?: StructureDiagnostics,
): TurnNode {
  const left = root.left!
  return copiedTurnNode(
    left.key,
    left.value,
    left.ordinal,
    left.left,
    copiedTurnNode(
      root.key,
      root.value,
      root.ordinal,
      left.right,
      root.right,
      diagnostics,
    ),
    diagnostics,
  )
}

function balance(root: TurnNode, diagnostics?: StructureDiagnostics): TurnNode {
  const delta = nodeHeight(root.left) - nodeHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateRight(
      nodeHeight(left.left) < nodeHeight(left.right)
        ? copiedTurnNode(
            root.key,
            root.value,
            root.ordinal,
            rotateLeft(left, diagnostics),
            root.right,
            diagnostics,
          )
        : root,
      diagnostics,
    )
  }
  if (delta < -1) {
    const right = root.right!
    return rotateLeft(
      nodeHeight(right.right) < nodeHeight(right.left)
        ? copiedTurnNode(
            root.key,
            root.value,
            root.ordinal,
            root.left,
            rotateRight(right, diagnostics),
            diagnostics,
          )
        : root,
      diagnostics,
    )
  }
  return root
}

function turnValue(
  root: TurnNode | undefined,
  key: string,
  diagnostics?: StructureDiagnostics,
): Turn | undefined {
  while (root) {
    bump(diagnostics, "conversationTurnRecordLookupNodeVisits")
    if (key === root.key) return root.value
    root = key < root.key ? root.left : root.right
  }
  return undefined
}

function setTurnNode(
  root: TurnNode | undefined,
  key: string,
  value: Turn,
  ordinal: number,
  diagnostics?: StructureDiagnostics,
): {
  readonly root: TurnNode
  readonly added: boolean
  readonly changed: boolean
  readonly previousValue?: Turn
} {
  bump(diagnostics, "conversationTurnRecordNodeVisits")
  if (!root)
    return {
      root: copiedTurnNode(
        key,
        value,
        ordinal,
        undefined,
        undefined,
        diagnostics,
      ),
      added: true,
      changed: true,
    }
  if (key === root.key) {
    if (root.value === value)
      return { root, added: false, changed: false, previousValue: root.value }
    return {
      root: copiedTurnNode(
        key,
        value,
        root.ordinal,
        root.left,
        root.right,
        diagnostics,
      ),
      added: false,
      changed: true,
      previousValue: root.value,
    }
  }
  if (key < root.key) {
    const next = setTurnNode(root.left, key, value, ordinal, diagnostics)
    if (!next.changed)
      return {
        root,
        added: false,
        changed: false,
        previousValue: next.previousValue,
      }
    return {
      root: balance(
        copiedTurnNode(
          root.key,
          root.value,
          root.ordinal,
          next.root,
          root.right,
          diagnostics,
        ),
        diagnostics,
      ),
      added: next.added,
      changed: true,
      previousValue: next.previousValue,
    }
  }
  const next = setTurnNode(root.right, key, value, ordinal, diagnostics)
  if (!next.changed)
    return {
      root,
      added: false,
      changed: false,
      previousValue: next.previousValue,
    }
  return {
    root: balance(
      copiedTurnNode(
        root.key,
        root.value,
        root.ordinal,
        root.left,
        next.root,
        diagnostics,
      ),
      diagnostics,
    ),
    added: next.added,
    changed: true,
    previousValue: next.previousValue,
  }
}

function entries(root: TurnNode | undefined, result: TurnEntry[]): void {
  if (!root) return
  entries(root.left, result)
  result.push({ key: root.key, value: root.value, ordinal: root.ordinal })
  entries(root.right, result)
}

function ordinaryRecordKeys(values: readonly TurnEntry[]): string[] {
  const indexed: number[] = []
  const named: TurnEntry[] = []
  for (const entry of values) {
    const number = Number(entry.key)
    if (
      Number.isInteger(number) &&
      number >= 0 &&
      number < 0xffff_ffff &&
      String(number) === entry.key
    )
      indexed.push(number)
    else named.push(entry)
  }
  indexed.sort((left, right) => left - right)
  named.sort((left, right) => left.ordinal - right.ordinal)
  return [...indexed.map(String), ...named.map((entry) => entry.key)]
}

function turnRecord(data: TurnRecordData): Readonly<Record<string, Turn>> {
  const target = Object.create(null) as Record<string, Turn>
  const proxy = new Proxy(target, {
    get: (_target, property) =>
      typeof property === "string"
        ? turnValue(data.root, property)
        : Reflect.get(target, property),
    has: (_target, property) =>
      typeof property === "string"
        ? turnValue(data.root, property) !== undefined
        : false,
    ownKeys: () => {
      const values: TurnEntry[] = []
      entries(data.root, values)
      return ordinaryRecordKeys(values)
    },
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" &&
      turnValue(data.root, property) !== undefined
        ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: turnValue(data.root, property),
          }
        : undefined,
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  turnRecordData.set(proxy, data)
  return proxy
}

function normalizedTurn(turn: Turn, diagnostics?: StructureDiagnostics): Turn {
  const itemIds = persistentTurnItemIds(turn.itemIds, diagnostics)
  return itemIds === turn.itemIds ? turn : { ...turn, itemIds }
}

export function persistentConversationTurns(
  value: Readonly<Record<string, Turn>> = {},
  diagnostics?: StructureDiagnostics,
): Readonly<Record<string, Turn>> {
  if (turnRecordData.has(value)) return value
  const cached = normalizedTurnRecords.get(value)
  if (cached) return cached
  const sourceEntries = Object.entries(value)
  bump(diagnostics, "conversationTurnRecordNormalizations")
  bump(
    diagnostics,
    "conversationTurnRecordNormalizationVisits",
    sourceEntries.length,
  )
  const values = sourceEntries
    .map(([key, turn], ordinal) => ({
      key,
      turn: normalizedTurn(turn, diagnostics),
      ordinal,
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    )
  const build = (from: number, to: number): TurnNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const { key, turn, ordinal } = values[middle]!
    return turnNode(
      key,
      turn,
      ordinal,
      build(from, middle),
      build(middle + 1, to),
    )
  }
  const record = turnRecord({
    token: Object.freeze({}),
    root: build(0, values.length),
    size: values.length,
    nextOrdinal: values.length,
  })
  normalizedTurnRecords.set(value, record)
  return record
}

export function setConversationTurn(
  value: Readonly<Record<string, Turn>>,
  turn: Turn,
  diagnostics?: StructureDiagnostics,
): Readonly<Record<string, Turn>> {
  const record = persistentConversationTurns(value, diagnostics)
  const data = turnRecordData.get(record)!
  const normalized = normalizedTurn(turn, diagnostics)
  const next = setTurnNode(
    data.root,
    turn.id,
    normalized,
    data.nextOrdinal,
    diagnostics,
  )
  if (!next.changed) return record
  bump(diagnostics, "conversationTurnRecordUpdates")
  return turnRecord({
    token: Object.freeze({}),
    root: next.root,
    size: data.size + (next.added ? 1 : 0),
    nextOrdinal: data.nextOrdinal + (next.added ? 1 : 0),
    lineage: {
      previousRoot: data.root,
      previousSize: data.size,
      previousToken: data.token,
      updatedKey: turn.id,
      previousValue: next.previousValue,
      updatedValue: normalized,
      ...(data.lineage
        ? {
            prior: {
              previousRoot: data.lineage.previousRoot,
              previousSize: data.lineage.previousSize,
              previousToken: data.lineage.previousToken,
              updatedKey: data.lineage.updatedKey,
              previousValue: data.lineage.previousValue,
              updatedValue: data.lineage.updatedValue,
            },
          }
        : {}),
    },
  })
}

/** Proves an exact new-turn record admission followed immediately by one update of that same turn. */
export function isConversationTurnAdditionThenUpdate(
  previous: Readonly<Record<string, Turn>>,
  next: Readonly<Record<string, Turn>>,
  turnId: string,
  nextTurn: Turn,
): boolean {
  const previousData = turnRecordData.get(previous)
  const data = turnRecordData.get(next)
  const current = data?.lineage
  const admission = current?.prior
  return (
    previousData !== undefined &&
    data !== undefined &&
    current !== undefined &&
    admission !== undefined &&
    admission.previousToken === previousData.token &&
    admission.previousRoot === previousData.root &&
    admission.previousSize === previousData.size &&
    admission.updatedKey === turnId &&
    admission.previousValue === undefined &&
    admission.updatedValue === current.previousValue &&
    current.updatedKey === turnId &&
    current.updatedValue === nextTurn &&
    data.size === previousData.size + 1
  )
}

/** Proves the two record writes above and the intervening exact item-id append without scanning either record. */
export function isConversationTurnAdditionThenItemAppend(
  previous: Readonly<Record<string, Turn>>,
  next: Readonly<Record<string, Turn>>,
  turnId: string,
  itemId: ItemId,
  nextTurn: Turn,
): boolean {
  const current = turnRecordData.get(next)?.lineage
  const admitted = current?.previousValue
  return (
    admitted !== undefined &&
    isConversationTurnAdditionThenUpdate(previous, next, turnId, nextTurn) &&
    admitted.id === nextTurn.id &&
    admitted.status === nextTurn.status &&
    admitted.startedAt === nextTurn.startedAt &&
    admitted.completedAt === nextTurn.completedAt &&
    admitted.durationMs === nextTurn.durationMs &&
    admitted.itemIds.length === 0 &&
    nextTurn.itemIds.length === 1 &&
    isTurnItemIdAppend(admitted.itemIds, nextTurn.itemIds, itemId)
  )
}

export function conversationTurnAt(
  value: Readonly<Record<string, Turn>>,
  turnId: string,
  diagnostics?: StructureDiagnostics,
): Turn | undefined {
  bump(diagnostics, "conversationTurnRecordLookups")
  const data = turnRecordData.get(value)
  return data
    ? turnValue(data.root, turnId, diagnostics)
    : Object.hasOwn(value, turnId)
      ? value[turnId]
      : undefined
}

export function isConversationTurnUpdate(
  previous: Readonly<Record<string, Turn>>,
  next: Readonly<Record<string, Turn>>,
  turnId: string,
  previousTurn: Turn | undefined,
  nextTurn: Turn,
): boolean {
  const data = turnRecordData.get(next)
  const previousData = turnRecordData.get(previous)
  return (
    data?.lineage !== undefined &&
    previousData !== undefined &&
    data.lineage.previousRoot === previousData.root &&
    data.lineage.previousSize === previousData.size &&
    data.lineage.previousToken === previousData.token &&
    data.lineage.updatedKey === turnId &&
    data.lineage.previousValue === previousTurn &&
    data.lineage.updatedValue === nextTurn &&
    data.size === previousData.size + (previousTurn ? 0 : 1)
  )
}

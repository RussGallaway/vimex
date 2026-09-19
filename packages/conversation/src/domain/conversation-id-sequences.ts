import type { ItemId, TurnId } from "./identifiers"

interface SequenceNode<T extends string> {
  readonly value: T
  readonly height: number
  readonly size: number
  readonly left?: SequenceNode<T>
  readonly right?: SequenceNode<T>
}

interface MembershipNode {
  readonly key: string
  readonly index: number
  readonly height: number
  readonly left?: MembershipNode
  readonly right?: MembershipNode
}

interface SequenceData<T extends string> {
  readonly token: object
  readonly root?: SequenceNode<T>
  readonly membership?: MembershipNode
  readonly size: number
  readonly lineage?: {
    readonly previousRoot?: SequenceNode<T>
    readonly previousMembership?: MembershipNode
    readonly previousSize: number
    readonly previousToken: object
    readonly appended: T
  }
}

export interface ConversationStructureDiagnostics {
  conversationTurnIdSequenceNormalizations: number
  conversationTurnIdSequenceNormalizationVisits: number
  conversationTurnIdSequenceAppends: number
  conversationTurnIdSequenceNodeVisits: number
  conversationTurnIdSequenceNodesCopied: number
  conversationTurnItemIdSequenceNormalizations: number
  conversationTurnItemIdSequenceNormalizationVisits: number
  conversationTurnItemIdSequenceAppends: number
  conversationTurnItemIdSequenceLookups: number
  conversationTurnItemIdSequenceLookupNodeVisits: number
  conversationTurnItemIdSequenceNodeVisits: number
  conversationTurnItemIdSequenceNodesCopied: number
  conversationTurnRecordNormalizations: number
  conversationTurnRecordNormalizationVisits: number
  conversationTurnRecordLookups: number
  conversationTurnRecordLookupNodeVisits: number
  conversationTurnRecordUpdates: number
  conversationTurnRecordNodeVisits: number
  conversationTurnRecordNodesCopied: number
}

export function createConversationStructureDiagnostics(): ConversationStructureDiagnostics {
  return {
    conversationTurnIdSequenceNormalizations: 0,
    conversationTurnIdSequenceNormalizationVisits: 0,
    conversationTurnIdSequenceAppends: 0,
    conversationTurnIdSequenceNodeVisits: 0,
    conversationTurnIdSequenceNodesCopied: 0,
    conversationTurnItemIdSequenceNormalizations: 0,
    conversationTurnItemIdSequenceNormalizationVisits: 0,
    conversationTurnItemIdSequenceAppends: 0,
    conversationTurnItemIdSequenceLookups: 0,
    conversationTurnItemIdSequenceLookupNodeVisits: 0,
    conversationTurnItemIdSequenceNodeVisits: 0,
    conversationTurnItemIdSequenceNodesCopied: 0,
    conversationTurnRecordNormalizations: 0,
    conversationTurnRecordNormalizationVisits: 0,
    conversationTurnRecordLookups: 0,
    conversationTurnRecordLookupNodeVisits: 0,
    conversationTurnRecordUpdates: 0,
    conversationTurnRecordNodeVisits: 0,
    conversationTurnRecordNodesCopied: 0,
  }
}

type StructureDiagnostics = Partial<ConversationStructureDiagnostics>
type SequenceKind = "turn" | "item"
type NumericKey = keyof ConversationStructureDiagnostics

const sequenceData = new WeakMap<object, SequenceData<string>>()
const normalizedTurnIds = new WeakMap<object, readonly TurnId[]>()
const normalizedItemIds = new WeakMap<object, readonly ItemId[]>()

function bump(diagnostics: StructureDiagnostics | undefined, key: NumericKey, amount = 1): void {
  if (diagnostics) diagnostics[key] = (diagnostics[key] ?? 0) + amount
}

function diagnosticKey(kind: SequenceKind, suffix: "Normalizations" | "NormalizationVisits" | "Appends" | "NodeVisits" | "NodesCopied"): NumericKey {
  return `conversationTurn${kind === "turn" ? "Id" : "ItemId"}Sequence${suffix}` as NumericKey
}

const sequenceHeight = <T extends string>(node: SequenceNode<T> | undefined) => node?.height ?? 0
const sequenceSize = <T extends string>(node: SequenceNode<T> | undefined) => node?.size ?? 0

function sequenceNode<T extends string>(value: T, left?: SequenceNode<T>, right?: SequenceNode<T>): SequenceNode<T> {
  return Object.freeze({
    value,
    height: Math.max(sequenceHeight(left), sequenceHeight(right)) + 1,
    size: sequenceSize(left) + sequenceSize(right) + 1,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
  })
}

function copiedSequenceNode<T extends string>(
  value: T,
  left: SequenceNode<T> | undefined,
  right: SequenceNode<T> | undefined,
  kind: SequenceKind,
  diagnostics?: StructureDiagnostics,
): SequenceNode<T> {
  bump(diagnostics, diagnosticKey(kind, "NodesCopied"))
  return sequenceNode(value, left, right)
}

function rotateSequenceLeft<T extends string>(root: SequenceNode<T>, kind: SequenceKind, diagnostics?: StructureDiagnostics): SequenceNode<T> {
  const right = root.right!
  return copiedSequenceNode(right.value,
    copiedSequenceNode(root.value, root.left, right.left, kind, diagnostics), right.right, kind, diagnostics)
}

function rotateSequenceRight<T extends string>(root: SequenceNode<T>, kind: SequenceKind, diagnostics?: StructureDiagnostics): SequenceNode<T> {
  const left = root.left!
  return copiedSequenceNode(left.value, left.left,
    copiedSequenceNode(root.value, left.right, root.right, kind, diagnostics), kind, diagnostics)
}

function balanceSequence<T extends string>(root: SequenceNode<T>, kind: SequenceKind, diagnostics?: StructureDiagnostics): SequenceNode<T> {
  const delta = sequenceHeight(root.left) - sequenceHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateSequenceRight(sequenceHeight(left.left) < sequenceHeight(left.right)
      ? copiedSequenceNode(root.value, rotateSequenceLeft(left, kind, diagnostics), root.right, kind, diagnostics)
      : root, kind, diagnostics)
  }
  if (delta < -1) {
    const right = root.right!
    return rotateSequenceLeft(sequenceHeight(right.right) < sequenceHeight(right.left)
      ? copiedSequenceNode(root.value, root.left, rotateSequenceRight(right, kind, diagnostics), kind, diagnostics)
      : root, kind, diagnostics)
  }
  return root
}

function appendSequenceNode<T extends string>(
  root: SequenceNode<T> | undefined,
  value: T,
  kind: SequenceKind,
  diagnostics?: StructureDiagnostics,
): SequenceNode<T> {
  bump(diagnostics, diagnosticKey(kind, "NodeVisits"))
  if (!root) return copiedSequenceNode(value, undefined, undefined, kind, diagnostics)
  const right = appendSequenceNode(root.right, value, kind, diagnostics)
  return balanceSequence(copiedSequenceNode(root.value, root.left, right, kind, diagnostics), kind, diagnostics)
}

function sequenceValue<T extends string>(root: SequenceNode<T> | undefined, index: number): T | undefined {
  while (root) {
    const leftSize = sequenceSize(root.left)
    if (index === leftSize) return root.value
    if (index < leftSize) root = root.left
    else { index -= leftSize + 1; root = root.right }
  }
  return undefined
}

const membershipHeight = (node: MembershipNode | undefined) => node?.height ?? 0

function membershipNode(key: string, index: number, left?: MembershipNode, right?: MembershipNode): MembershipNode {
  return Object.freeze({ key, index, height: Math.max(membershipHeight(left), membershipHeight(right)) + 1,
    ...(left ? { left } : {}), ...(right ? { right } : {}) })
}

function copiedMembershipNode(
  key: string,
  index: number,
  left: MembershipNode | undefined,
  right: MembershipNode | undefined,
  kind: SequenceKind,
  diagnostics?: StructureDiagnostics,
): MembershipNode {
  bump(diagnostics, diagnosticKey(kind, "NodesCopied"))
  return membershipNode(key, index, left, right)
}

function rotateMembershipLeft(root: MembershipNode, kind: SequenceKind, diagnostics?: StructureDiagnostics): MembershipNode {
  const right = root.right!
  return copiedMembershipNode(right.key, right.index,
    copiedMembershipNode(root.key, root.index, root.left, right.left, kind, diagnostics), right.right, kind, diagnostics)
}

function rotateMembershipRight(root: MembershipNode, kind: SequenceKind, diagnostics?: StructureDiagnostics): MembershipNode {
  const left = root.left!
  return copiedMembershipNode(left.key, left.index, left.left,
    copiedMembershipNode(root.key, root.index, left.right, root.right, kind, diagnostics), kind, diagnostics)
}

function balanceMembership(root: MembershipNode, kind: SequenceKind, diagnostics?: StructureDiagnostics): MembershipNode {
  const delta = membershipHeight(root.left) - membershipHeight(root.right)
  if (delta > 1) {
    const left = root.left!
    return rotateMembershipRight(membershipHeight(left.left) < membershipHeight(left.right)
      ? copiedMembershipNode(root.key, root.index, rotateMembershipLeft(left, kind, diagnostics), root.right, kind, diagnostics)
      : root, kind, diagnostics)
  }
  if (delta < -1) {
    const right = root.right!
    return rotateMembershipLeft(membershipHeight(right.right) < membershipHeight(right.left)
      ? copiedMembershipNode(root.key, root.index, root.left, rotateMembershipRight(right, kind, diagnostics), kind, diagnostics)
      : root, kind, diagnostics)
  }
  return root
}

function setMembershipNode(
  root: MembershipNode | undefined,
  key: string,
  index: number,
  kind: SequenceKind,
  diagnostics?: StructureDiagnostics,
): MembershipNode {
  bump(diagnostics, diagnosticKey(kind, "NodeVisits"))
  if (!root) return copiedMembershipNode(key, index, undefined, undefined, kind, diagnostics)
  if (key === root.key) return root
  if (key < root.key) {
    const left = setMembershipNode(root.left, key, index, kind, diagnostics)
    return left === root.left ? root : balanceMembership(copiedMembershipNode(root.key, root.index, left, root.right, kind, diagnostics), kind, diagnostics)
  }
  const right = setMembershipNode(root.right, key, index, kind, diagnostics)
  return right === root.right ? root : balanceMembership(copiedMembershipNode(root.key, root.index, root.left, right, kind, diagnostics), kind, diagnostics)
}

function membershipIndex(root: MembershipNode | undefined, key: string, diagnostics?: StructureDiagnostics): number | undefined {
  while (root) {
    bump(diagnostics, "conversationTurnItemIdSequenceLookupNodeVisits")
    if (key === root.key) return root.index
    root = key < root.key ? root.left : root.right
  }
  return undefined
}

function arrayIndex(property: string, length: number): number | undefined {
  const index = Number(property)
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === property ? index : undefined
}

function persistentSequence<T extends string>(data: SequenceData<T>): readonly T[] {
  const target: T[] = []
  target.length = data.size
  const proxy = new Proxy(target, {
    get: (_target, property, receiver) => {
      if (typeof property === "string") {
        const index = arrayIndex(property, data.size)
        if (index !== undefined) return sequenceValue(data.root, index)
      }
      return Reflect.get(target, property, receiver)
    },
    has: (_target, property) => typeof property === "string" && arrayIndex(property, data.size) !== undefined
      ? true : Reflect.has(target, property),
    ownKeys: () => [...Array.from({ length: data.size }, (_, index) => String(index)), "length"],
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === "length") return Reflect.getOwnPropertyDescriptor(target, property)
      if (typeof property !== "string") return undefined
      const index = arrayIndex(property, data.size)
      return index === undefined ? undefined
        : { configurable: true, enumerable: true, writable: false, value: sequenceValue(data.root, index) }
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  sequenceData.set(proxy, data as SequenceData<string>)
  return proxy
}

function normalizeSequence<T extends string>(
  value: readonly T[],
  kind: SequenceKind,
  cache: WeakMap<object, readonly T[]>,
  diagnostics?: StructureDiagnostics,
): readonly T[] {
  if (sequenceData.has(value)) return value
  const cached = cache.get(value)
  if (cached) return cached
  bump(diagnostics, diagnosticKey(kind, "Normalizations"))
  bump(diagnostics, diagnosticKey(kind, "NormalizationVisits"), value.length)
  const buildSequence = (from: number, to: number): SequenceNode<T> | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    return sequenceNode(value[middle]!, buildSequence(from, middle), buildSequence(middle + 1, to))
  }
  const sorted = value.map((key, index) => ({ key, index }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index)
  const buildMembership = (from: number, to: number): MembershipNode | undefined => {
    if (from >= to) return undefined
    const middle = (from + to) >>> 1
    const { key, index } = sorted[middle]!
    return membershipNode(key, index, buildMembership(from, middle), buildMembership(middle + 1, to))
  }
  const result = persistentSequence({ token: Object.freeze({}), root: buildSequence(0, value.length),
    membership: buildMembership(0, sorted.length), size: value.length })
  cache.set(value, result)
  return result
}

function appendSequence<T extends string>(value: readonly T[], next: T, kind: SequenceKind, diagnostics?: StructureDiagnostics): readonly T[] {
  const normalized = normalizeSequence(value, kind,
    (kind === "turn" ? normalizedTurnIds : normalizedItemIds) as unknown as WeakMap<object, readonly T[]>, diagnostics)
  const data = sequenceData.get(normalized)! as SequenceData<T>
  bump(diagnostics, diagnosticKey(kind, "Appends"))
  return persistentSequence({
    token: Object.freeze({}),
    root: appendSequenceNode(data.root, next, kind, diagnostics),
    membership: setMembershipNode(data.membership, next, data.size, kind, diagnostics),
    size: data.size + 1,
    lineage: { previousRoot: data.root, previousMembership: data.membership, previousSize: data.size,
      previousToken: data.token, appended: next },
  })
}

export function persistentConversationTurnIds(value: readonly TurnId[] = [], diagnostics?: StructureDiagnostics): readonly TurnId[] {
  return normalizeSequence(value, "turn", normalizedTurnIds, diagnostics)
}

export function appendConversationTurnId(value: readonly TurnId[], next: TurnId, diagnostics?: StructureDiagnostics): readonly TurnId[] {
  return appendSequence(value, next, "turn", diagnostics)
}

export function persistentTurnItemIds(value: readonly ItemId[] = [], diagnostics?: StructureDiagnostics): readonly ItemId[] {
  return normalizeSequence(value, "item", normalizedItemIds, diagnostics)
}

export function appendTurnItemId(value: readonly ItemId[], next: ItemId, diagnostics?: StructureDiagnostics): readonly ItemId[] {
  return appendSequence(value, next, "item", diagnostics)
}

export function turnItemIdsHave(value: readonly ItemId[], itemId: ItemId, diagnostics?: StructureDiagnostics): boolean {
  bump(diagnostics, "conversationTurnItemIdSequenceLookups")
  const data = sequenceData.get(value)
  return data ? membershipIndex(data.membership, itemId, diagnostics) !== undefined : value.includes(itemId)
}

export function isConversationTurnIdAppend(previous: readonly TurnId[], next: readonly TurnId[], appended: TurnId): boolean {
  const data = sequenceData.get(next) as SequenceData<TurnId> | undefined
  const previousData = sequenceData.get(previous) as SequenceData<TurnId> | undefined
  return data?.lineage !== undefined && previousData !== undefined
    && data.lineage.previousRoot === previousData.root
    && data.lineage.previousMembership === previousData.membership
    && data.lineage.previousSize === previousData.size && data.lineage.previousToken === previousData.token
    && data.lineage.appended === appended && data.size === previousData.size + 1
}

export function isTurnItemIdAppend(previous: readonly ItemId[] | undefined, next: readonly ItemId[], appended: ItemId): boolean {
  const data = sequenceData.get(next) as SequenceData<ItemId> | undefined
  const lineage = data?.lineage
  if (!lineage) return false
  const previousData = previous === undefined ? undefined : sequenceData.get(previous) as SequenceData<ItemId> | undefined
  const matchesPrevious = previous === undefined
    ? lineage.previousSize === 0
    : previousData !== undefined && lineage.previousRoot === previousData.root
      && lineage.previousMembership === previousData.membership && lineage.previousSize === previousData.size
      && lineage.previousToken === previousData.token
  return matchesPrevious && lineage.appended === appended && data.size === lineage.previousSize + 1
}

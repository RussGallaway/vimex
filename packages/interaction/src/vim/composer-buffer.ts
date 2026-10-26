import type {
  ComposerMotion,
  ComposerTextObject,
  ComposerVimAction,
} from "./composer-grammar"
import type { VimRegister } from "./state-machine"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
// Cursor-only motions and native cursor synchronization share the same text.
// Retain one bounded revision, never an undo history or an unbounded paste.
const maxCachedCodeUnits = 65_536
let cachedText:
  | { text: string; parts: readonly string[]; boundaries: readonly number[] }
  | undefined

function textIndex(text: string): typeof cachedText {
  if (text.length > maxCachedCodeUnits) {
    cachedText = undefined
    return undefined
  }
  if (cachedText?.text === text) return cachedText
  const parts: string[] = []
  const boundaries: number[] = []
  for (const part of segmenter.segment(text)) {
    parts.push(part.segment)
    boundaries.push(part.index)
  }
  boundaries.push(text.length)
  cachedText = { text, parts, boundaries }
  return cachedText
}

const split = (value: string): readonly string[] =>
  textIndex(value)?.parts ??
  [...segmenter.segment(value)].map(({ segment }) => segment)

/** Converts a JavaScript text control's UTF-16 cursor boundary to a safe grapheme boundary. */
export function codeUnitOffsetToGraphemeOffset(
  text: string,
  offset: number,
): number {
  const bounded = clamp(offset, 0, text.length)
  const index = textIndex(text)
  if (index) {
    if (Number.isNaN(bounded)) return index.parts.length
    let low = 0
    let high = index.boundaries.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (index.boundaries[middle]! <= bounded) low = middle
      else high = middle - 1
    }
    return low
  }
  let graphemeOffset = 0
  for (const part of segmenter.segment(text)) {
    if (part.index >= bounded) break
    if (part.index + part.segment.length > bounded) break
    graphemeOffset++
  }
  return graphemeOffset
}

/** Converts a grapheme cursor boundary to a JavaScript UTF-16 string offset. */
export function graphemeOffsetToCodeUnitOffset(
  text: string,
  offset: number,
): number {
  const target = Math.max(0, Math.trunc(offset))
  const index = textIndex(text)
  if (index) return index.boundaries[target] ?? text.length
  let graphemeOffset = 0
  for (const part of segmenter.segment(text)) {
    if (graphemeOffset++ === target) return part.index
  }
  return text.length
}

export interface ComposerBufferSelection {
  readonly anchor: number
  readonly head: number
  readonly shape?: "character" | "line"
}

export interface ComposerBuffer {
  readonly text: string
  readonly cursorOffset: number
  readonly preferredColumn?: number
  readonly selection?: ComposerBufferSelection
}

export type ComposerBufferEffect =
  | { readonly type: "submit" }
  | { readonly type: "history"; readonly direction: "undo" | "redo" }
  | { readonly type: "copy"; readonly text: string }
  | { readonly type: "retry" }
  | { readonly type: "invalid-text-object" }

export interface ComposerBufferResult {
  readonly buffer: ComposerBuffer
  readonly register: VimRegister
  readonly effect?: ComposerBufferEffect
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

function lineStart(parts: readonly string[], offset: number): number {
  let cursor = clamp(offset, 0, parts.length)
  while (cursor > 0 && parts[cursor - 1] !== "\n") cursor--
  return cursor
}

function lineEnd(parts: readonly string[], offset: number): number {
  let cursor = lineStart(parts, offset)
  while (cursor < parts.length && parts[cursor] !== "\n") cursor++
  return cursor
}

function firstContent(parts: readonly string[], offset: number): number {
  const start = lineStart(parts, offset)
  let cursor = start
  const end = lineEnd(parts, cursor)
  while (cursor < end && /^[ \t]$/u.test(parts[cursor]!)) cursor++
  return cursor < end ? cursor : start
}

function normalLineTarget(
  parts: readonly string[],
  start: number,
  end: number,
  column: number,
): number {
  return end > start ? Math.min(start + column, end - 1) : start
}

function category(
  value: string | undefined,
): "space" | "keyword" | "punctuation" {
  if (!value || /^\s$/u.test(value)) return "space"
  return /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u.test(value)
    ? "keyword"
    : "punctuation"
}

function wordForward(
  parts: readonly string[],
  origin: number,
  big = false,
): number {
  const wordCategory = (value: string | undefined) =>
    big && category(value) !== "space" ? "keyword" : category(value)
  let cursor = clamp(origin, 0, Math.max(0, parts.length - 1))
  const kind = wordCategory(parts[cursor])
  if (kind !== "space")
    while (cursor < parts.length && wordCategory(parts[cursor]) === kind)
      cursor++
  while (cursor < parts.length && wordCategory(parts[cursor]) === "space")
    cursor++
  return Math.min(cursor, Math.max(0, parts.length - 1))
}

function wordBackward(
  parts: readonly string[],
  origin: number,
  big = false,
): number {
  const wordCategory = (value: string | undefined) =>
    big && category(value) !== "space" ? "keyword" : category(value)
  let cursor = clamp(origin - 1, 0, Math.max(0, parts.length - 1))
  while (cursor > 0 && wordCategory(parts[cursor]) === "space") cursor--
  const kind = wordCategory(parts[cursor])
  while (cursor > 0 && wordCategory(parts[cursor - 1]) === kind) cursor--
  return cursor
}

function wordEnd(
  parts: readonly string[],
  origin: number,
  big = false,
): number {
  if (parts.length === 0) return 0
  const wordCategory = (value: string | undefined) =>
    big && category(value) !== "space" ? "keyword" : category(value)
  let cursor = clamp(origin, 0, parts.length - 1)
  const current = wordCategory(parts[cursor])
  if (
    current !== "space" &&
    cursor + 1 < parts.length &&
    wordCategory(parts[cursor + 1]) === current
  ) {
    while (
      cursor + 1 < parts.length &&
      wordCategory(parts[cursor + 1]) === current
    )
      cursor++
    return cursor
  }
  cursor++
  while (cursor < parts.length && wordCategory(parts[cursor]) === "space")
    cursor++
  if (cursor >= parts.length) return parts.length - 1
  const kind = wordCategory(parts[cursor])
  while (cursor + 1 < parts.length && wordCategory(parts[cursor + 1]) === kind)
    cursor++
  return cursor
}

function targetLine(parts: readonly string[], oneBasedLine: number): number {
  let start = 0
  for (let line = 1; line < oneBasedLine && start < parts.length; line++) {
    const end = lineEnd(parts, start)
    if (end >= parts.length) break
    start = end + 1
  }
  return firstContent(parts, start)
}

function lastLine(parts: readonly string[]): number {
  return firstContent(parts, lineStart(parts, parts.length))
}

function moveOnce(
  parts: readonly string[],
  offset: number,
  motion: ComposerMotion,
): number {
  const start = lineStart(parts, offset)
  const end = lineEnd(parts, offset)
  switch (motion) {
    case "left":
      return Math.max(start, offset - 1)
    case "right":
      return normalLineTarget(parts, start, end, offset - start + 1)
    case "line-start":
      return start
    case "first-content":
      return firstContent(parts, offset)
    case "line-end":
      return end > start ? end - 1 : start
    case "WORD-forward":
      return wordForward(parts, offset, true)
    case "WORD-backward":
      return wordBackward(parts, offset, true)
    case "WORD-end":
      return wordEnd(parts, offset, true)
    case "word-forward":
      return wordForward(parts, offset)
    case "word-backward":
      return wordBackward(parts, offset)
    case "word-end":
      return wordEnd(parts, offset)
    case "up": {
      if (start === 0) return offset
      const previousEnd = start - 1
      const previousStart = lineStart(parts, previousEnd)
      return normalLineTarget(parts, previousStart, previousEnd, offset - start)
    }
    case "down": {
      if (end >= parts.length) return offset
      const nextStart = end + 1
      return normalLineTarget(
        parts,
        nextStart,
        lineEnd(parts, nextStart),
        offset - start,
      )
    }
    case "document-start":
      return targetLine(parts, 1)
    case "document-end":
      return lastLine(parts)
  }
}

function moveBuffer(
  buffer: ComposerBuffer,
  motion: ComposerMotion,
  count: number,
  select: boolean,
): ComposerBuffer {
  const parts = split(buffer.text)
  const origin = clamp(buffer.cursorOffset, 0, parts.length)
  let target = origin
  if (motion === "document-start")
    target = targetLine(parts, Math.max(1, count))
  else if (motion === "document-end" && count > 0)
    target = targetLine(parts, count)
  else if (motion === "line-end") {
    let end = lineEnd(parts, origin)
    for (let line = 1; line < Math.max(1, count) && end < parts.length; line++)
      end = lineEnd(parts, end + 1)
    const start = lineStart(parts, end)
    target = end > start ? end - 1 : start
  } else if (motion === "up" || motion === "down") {
    const column = buffer.preferredColumn ?? origin - lineStart(parts, origin)
    target = origin
    for (let step = 0; step < Math.max(1, count); step++) {
      const start = lineStart(parts, target)
      const end = lineEnd(parts, target)
      if (motion === "up") {
        if (start === 0) break
        const previousEnd = start - 1
        const previousStart = lineStart(parts, previousEnd)
        target = normalLineTarget(parts, previousStart, previousEnd, column)
      } else {
        if (end >= parts.length) break
        const nextStart = end + 1
        target = normalLineTarget(
          parts,
          nextStart,
          lineEnd(parts, nextStart),
          column,
        )
      }
    }
  } else {
    for (let step = 0; step < Math.max(1, count); step++)
      target = moveOnce(parts, target, motion)
  }
  return {
    text: buffer.text,
    cursorOffset: target,
    ...(motion === "up" || motion === "down"
      ? {
          preferredColumn:
            buffer.preferredColumn ?? origin - lineStart(parts, origin),
        }
      : {}),
    selection: select
      ? {
          ...buffer.selection,
          anchor: buffer.selection?.anchor ?? origin,
          head: target,
        }
      : undefined,
  }
}

function replace(
  parts: readonly string[],
  from: number,
  to: number,
  inserted: readonly string[],
): string[] {
  return [...parts.slice(0, from), ...inserted, ...parts.slice(to)]
}

function normalCursor(parts: readonly string[], desired: number): number {
  if (parts.length === 0) return 0
  const bounded = clamp(desired, 0, parts.length - 1)
  const start = lineStart(parts, bounded)
  const end = lineEnd(parts, bounded)
  return normalLineTarget(parts, start, end, bounded - start)
}

function deleteCharacters(
  buffer: ComposerBuffer,
  count: number,
): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  const end = Math.min(lineEnd(parts, cursor), cursor + Math.max(1, count))
  if (cursor >= end) return { buffer }
  const register = {
    text: parts.slice(cursor, end).join(""),
    shape: "character" as const,
  }
  const next = replace(parts, cursor, end, [])
  return {
    buffer: { text: next.join(""), cursorOffset: normalCursor(next, cursor) },
    register,
  }
}

function deleteLines(
  buffer: ComposerBuffer,
  count: number,
): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const start = lineStart(parts, buffer.cursorOffset)
  let end = start
  for (let line = 0; line < Math.max(1, count); line++) {
    end = lineEnd(parts, end)
    if (end < parts.length) end++
    else break
  }
  const registerEnd = end > start && parts[end - 1] === "\n" ? end - 1 : end
  const register = {
    text: parts.slice(start, registerEnd).join(""),
    shape: "line" as const,
  }
  const removalStart =
    end === parts.length && start > 0 && parts[start - 1] === "\n"
      ? start - 1
      : start
  const next = replace(parts, removalStart, end, [])
  return {
    buffer: { text: next.join(""), cursorOffset: normalCursor(next, start) },
    register,
  }
}

function deleteToLineEnd(
  buffer: ComposerBuffer,
  count: number,
  insertMode: boolean,
): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  let end = lineEnd(parts, cursor)
  for (let line = 1; line < Math.max(1, count) && end < parts.length; line++)
    end = lineEnd(parts, end + 1)
  if (cursor >= end) return { buffer }
  const register = {
    text: parts.slice(cursor, end).join(""),
    shape: "character" as const,
  }
  const next = replace(parts, cursor, end, [])
  return {
    buffer: {
      text: next.join(""),
      cursorOffset: insertMode
        ? Math.min(cursor, next.length)
        : normalCursor(next, cursor),
    },
    register,
  }
}

function enterInsert(
  buffer: ComposerBuffer,
  placement: "before" | "after" | "line-start" | "line-end",
): ComposerBuffer {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  const end = lineEnd(parts, cursor)
  let target = cursor
  if (placement === "after") target = Math.min(cursor + 1, end)
  if (placement === "line-start") target = firstContent(parts, cursor)
  if (placement === "line-end") target = end
  return { text: buffer.text, cursorOffset: target }
}

function openLine(
  buffer: ComposerBuffer,
  placement: "above" | "below",
  count: number,
): ComposerBuffer {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  const amount = Math.max(1, count)
  if (placement === "above") {
    const position = lineStart(parts, cursor)
    const next = replace(parts, position, position, Array(amount).fill("\n"))
    return { text: next.join(""), cursorOffset: position }
  }
  const end = lineEnd(parts, cursor)
  const position = end < parts.length ? end + 1 : end
  const next = replace(parts, position, position, Array(amount).fill("\n"))
  return {
    text: next.join(""),
    cursorOffset: end < parts.length ? position : position + 1,
  }
}

function paste(
  buffer: ComposerBuffer,
  register: VimRegister,
  placement: "before" | "after",
  count: number,
): ComposerBuffer {
  if (!register.text) return buffer
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  if (register.shape === "character" || register.shape === "block") {
    const inserted = split(register.text.repeat(Math.max(1, count)))
    const position =
      placement === "after"
        ? Math.min(cursor + 1, lineEnd(parts, cursor))
        : cursor
    const next = replace(parts, position, position, inserted)
    return {
      text: next.join(""),
      cursorOffset: position + Math.max(0, inserted.length - 1),
    }
  }
  const payload = Array(Math.max(1, count)).fill(register.text).join("\n")
  const inserted = split(payload)
  const start = lineStart(parts, cursor)
  const end = lineEnd(parts, cursor)
  if (placement === "before") {
    const next = replace(parts, start, start, [...inserted, "\n"])
    return {
      text: next.join(""),
      cursorOffset: start + firstContent(inserted, 0),
    }
  }
  if (end < parts.length) {
    const position = end + 1
    const next = replace(parts, position, position, [...inserted, "\n"])
    return {
      text: next.join(""),
      cursorOffset: position + firstContent(inserted, 0),
    }
  }
  const separator = parts.length > 0 ? ["\n"] : []
  const next = replace(parts, end, end, [...separator, ...inserted])
  return {
    text: next.join(""),
    cursorOffset: end + separator.length + firstContent(inserted, 0),
  }
}

/** Half-open grapheme range; linewise payloads omit the final newline. */
export function composerSelectionRange(
  buffer: ComposerBuffer,
): { from: number; to: number } | undefined {
  if (!buffer.selection) return undefined
  const parts = split(buffer.text)
  const low = clamp(
    Math.min(buffer.selection.anchor, buffer.selection.head),
    0,
    parts.length,
  )
  const high = clamp(
    Math.max(buffer.selection.anchor, buffer.selection.head),
    0,
    parts.length,
  )
  return buffer.selection.shape === "line"
    ? { from: lineStart(parts, low), to: lineEnd(parts, high) }
    : { from: low, to: Math.min(parts.length, high + 1) }
}

function yank(
  buffer: ComposerBuffer,
  register: VimRegister,
): ComposerBufferResult {
  if (!buffer.selection) return { buffer, register }
  const parts = split(buffer.text)
  const { from, to } = composerSelectionRange(buffer)!
  const text = parts.slice(from, to).join("")
  const nextRegister = { text, shape: buffer.selection.shape ?? "character" }
  return {
    buffer: { text: buffer.text, cursorOffset: buffer.cursorOffset },
    register: nextRegister,
    effect: { type: "copy", text },
  }
}

function deleteSelection(
  buffer: ComposerBuffer,
  register: VimRegister,
  insertMode: boolean,
): ComposerBufferResult {
  if (!buffer.selection) return { buffer, register }
  const parts = split(buffer.text)
  const { from, to } = composerSelectionRange(buffer)!
  if (buffer.selection.shape === "line") {
    const lines =
      parts.slice(from, to).filter((part) => part === "\n").length + 1
    if (!insertMode) {
      const deleted = deleteLines(
        { text: buffer.text, cursorOffset: from },
        lines,
      )
      return { buffer: deleted.buffer, register: deleted.register ?? register }
    }
    const text = parts.slice(from, to).join("")
    const next = replace(parts, from, to, [])
    return {
      buffer: { text: next.join(""), cursorOffset: from },
      register: { text, shape: "line" },
    }
  }
  const text = parts.slice(from, to).join("")
  const next = replace(parts, from, to, [])
  return {
    buffer: {
      text: next.join(""),
      cursorOffset: insertMode
        ? Math.min(from, next.length)
        : normalCursor(next, from),
    },
    register: text ? { text, shape: "character" } : register,
  }
}

function textObjectRange(
  parts: readonly string[],
  cursor: number,
  object: ComposerTextObject,
  count: number,
): { from: number; to: number } | undefined {
  const inner = object.startsWith("inner-")
  const kind = object.replace(/^(inner|a)-/, "")
  const bounded = clamp(cursor, 0, Math.max(0, parts.length - 1))
  if (kind === "word" || kind === "WORD") {
    const big = kind === "WORD"
    const isSpace = (value: string | undefined) => !value || /^\s$/u.test(value)
    const isWord = (value: string | undefined) =>
      isSpace(value) ? "space" : big ? "word" : category(value)
    let from = bounded
    let to = bounded + 1
    if (isSpace(parts[bounded])) {
      while (from > 0 && isSpace(parts[from - 1])) from--
      while (to < parts.length && isSpace(parts[to])) to++
    } else {
      while (from > 0 && isWord(parts[from - 1]) === isWord(parts[bounded]))
        from--
      while (to < parts.length && isWord(parts[to]) === isWord(parts[bounded]))
        to++
    }
    const repetitions = Math.max(1, count)
    for (let repetition = 1; repetition < repetitions; repetition++) {
      while (to < parts.length && isSpace(parts[to])) to++
      if (to >= parts.length) break
      const segmentKind = isWord(parts[to])
      do to++
      while (to < parts.length && isWord(parts[to]) === segmentKind)
    }
    if (!inner) {
      const wordEnd = to
      while (to < parts.length && isSpace(parts[to])) to++
      // Vim's `a-word` consumes the following whitespace when present, or
      // the preceding whitespace for a word at the end of a line.
      if (to === wordEnd) while (from > 0 && isSpace(parts[from - 1])) from--
    }
    return { from, to }
  }
  const pairs: Record<string, [string, string]> = {
    quote: ['"', '"'],
    "single-quote": ["'", "'"],
    paren: ["(", ")"],
    bracket: ["[", "]"],
    brace: ["{", "}"],
  }
  const pair = pairs[kind]
  if (!pair) return undefined
  let open = -1
  let close = -1
  if (pair[0] === pair[1]) {
    // Pair unescaped quotes on the current line, including a cursor on either
    // delimiter. A quote ahead of the cursor is the next eligible object.
    const start = lineStart(parts, bounded)
    const end = lineEnd(parts, bounded)
    const quotes: number[] = []
    for (let index = start; index < end; index++) {
      if (parts[index] !== pair[0]) continue
      let slashes = 0
      for (
        let previous = index - 1;
        previous >= start && parts[previous] === "\\";
        previous--
      )
        slashes++
      if (slashes % 2 === 0) quotes.push(index)
    }
    for (let index = 0; index + 1 < quotes.length; index += 2) {
      if (quotes[index + 1]! < bounded) continue
      open = quotes[index]!
      close = quotes[index + 1]!
      break
    }
  } else {
    let depth = 0
    const searchFrom = parts[bounded] === pair[1] ? bounded - 1 : bounded
    for (let index = searchFrom; index >= 0; index--) {
      if (parts[index] === pair[1]) depth++
      else if (parts[index] === pair[0]) {
        if (depth === 0) {
          open = index
          break
        }
        depth--
      }
    }
    if (open < 0) return undefined
    depth = 0
    for (let index = open + 1; index < parts.length; index++) {
      if (parts[index] === pair[0]) depth++
      else if (parts[index] === pair[1]) {
        if (depth === 0) {
          close = index
          break
        }
        depth--
      }
    }
  }
  if (close <= open) return undefined
  return { from: inner ? open + 1 : open, to: inner ? close : close + 1 }
}

/** Applies semantic Vim behavior to a grapheme-indexed composer buffer. */
export function applyComposerVimAction(
  buffer: ComposerBuffer,
  action: ComposerVimAction,
  register: VimRegister = { text: "", shape: "character" },
): ComposerBufferResult {
  if (action.type === "motion")
    return {
      buffer: moveBuffer(buffer, action.motion, action.count, action.select),
      register,
    }
  buffer = {
    text: buffer.text,
    cursorOffset: buffer.cursorOffset,
    ...(buffer.selection ? { selection: buffer.selection } : {}),
  }
  if (action.type === "enter-insert")
    return { buffer: enterInsert(buffer, action.placement), register }
  if (action.type === "open-line")
    return {
      buffer: openLine(buffer, action.placement, action.count),
      register,
    }
  if (action.type === "paste")
    return {
      buffer: paste(buffer, register, action.placement, action.count),
      register,
    }
  if (action.type === "begin-visual") {
    return {
      buffer: {
        ...buffer,
        selection: {
          anchor: buffer.selection?.anchor ?? buffer.cursorOffset,
          head: buffer.cursorOffset,
          ...(action.shape ? { shape: action.shape } : {}),
        },
      },
      register,
    }
  }
  if (action.type === "swap-selection") {
    if (!buffer.selection) return { buffer, register }
    return {
      buffer: {
        ...buffer,
        cursorOffset: buffer.selection.anchor,
        selection: {
          ...buffer.selection,
          anchor: buffer.selection.head,
          head: buffer.selection.anchor,
        },
      },
      register,
    }
  }
  if (action.type === "clear-selection")
    return {
      buffer: { text: buffer.text, cursorOffset: buffer.cursorOffset },
      register,
    }
  if (action.type === "yank") return yank(buffer, register)
  if (action.type === "delete-selection")
    return deleteSelection(buffer, register, action.enterInsert ?? false)
  if (action.type === "text-object") {
    const parts = split(buffer.text)
    const range = textObjectRange(
      parts,
      buffer.cursorOffset,
      action.object,
      action.count,
    )
    if (!range)
      return { buffer, register, effect: { type: "invalid-text-object" } }
    const text = parts.slice(range.from, range.to).join("")
    const next = replace(parts, range.from, range.to, [])
    return {
      buffer: {
        text: next.join(""),
        cursorOffset:
          action.operator === "change"
            ? Math.min(range.from, next.length)
            : normalCursor(next, range.from),
      },
      register: { text, shape: "character" },
    }
  }
  if (action.type === "submit")
    return { buffer, register, effect: { type: "submit" } }
  if (action.type === "retry")
    return { buffer, register, effect: { type: "retry" } }
  if (action.operator === "undo" || action.operator === "redo") {
    return {
      buffer,
      register,
      effect: { type: "history", direction: action.operator },
    }
  }
  if (action.operator === "change-line") {
    const parts = split(buffer.text)
    const start = lineStart(parts, buffer.cursorOffset)
    let end = start
    for (let line = 0; line < Math.max(1, action.count); line++) {
      end = lineEnd(parts, end)
      if (line + 1 < action.count && end < parts.length) end++
    }
    return {
      buffer: {
        text: replace(parts, start, end, []).join(""),
        cursorOffset: start,
      },
      register: { text: parts.slice(start, end).join(""), shape: "line" },
    }
  }
  const changed =
    action.operator === "delete-char"
      ? deleteCharacters(buffer, action.count)
      : action.operator === "delete-line"
        ? deleteLines(buffer, action.count)
        : deleteToLineEnd(buffer, action.count, action.enterInsert ?? false)
  return { buffer: changed.buffer, register: changed.register ?? register }
}

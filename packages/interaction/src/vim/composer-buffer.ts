import type { ComposerMotion, ComposerVimAction } from "./composer-grammar"
import type { VimRegister } from "./state-machine"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const split = (value: string): string[] => [...segmenter.segment(value)].map(({ segment }) => segment)

/** Converts a JavaScript text control's UTF-16 cursor boundary to a safe grapheme boundary. */
export function codeUnitOffsetToGraphemeOffset(text: string, offset: number): number {
  const bounded = clamp(offset, 0, text.length)
  let graphemeOffset = 0
  for (const part of segmenter.segment(text)) {
    if (part.index >= bounded) break
    if (part.index + part.segment.length > bounded) break
    graphemeOffset++
  }
  return graphemeOffset
}

/** Converts a grapheme cursor boundary to a JavaScript UTF-16 string offset. */
export function graphemeOffsetToCodeUnitOffset(text: string, offset: number): number {
  const target = Math.max(0, Math.trunc(offset))
  let graphemeOffset = 0
  for (const part of segmenter.segment(text)) {
    if (graphemeOffset++ === target) return part.index
  }
  return text.length
}

export interface ComposerBufferSelection {
  readonly anchor: number
  readonly head: number
}

export interface ComposerBuffer {
  readonly text: string
  readonly cursorOffset: number
  readonly selection?: ComposerBufferSelection
}

export type ComposerBufferEffect =
  | { readonly type: "submit" }
  | { readonly type: "history"; readonly direction: "undo" | "redo" }
  | { readonly type: "copy"; readonly text: string }
  | { readonly type: "retry" }

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

function normalLineTarget(parts: readonly string[], start: number, end: number, column: number): number {
  return end > start ? Math.min(start + column, end - 1) : start
}

function category(value: string | undefined): "space" | "keyword" | "punctuation" {
  if (!value || /^\s$/u.test(value)) return "space"
  return /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u.test(value) ? "keyword" : "punctuation"
}

function wordForward(parts: readonly string[], origin: number): number {
  let cursor = clamp(origin, 0, Math.max(0, parts.length - 1))
  const kind = category(parts[cursor])
  if (kind !== "space") while (cursor < parts.length && category(parts[cursor]) === kind) cursor++
  while (cursor < parts.length && category(parts[cursor]) === "space") cursor++
  return Math.min(cursor, Math.max(0, parts.length - 1))
}

function wordBackward(parts: readonly string[], origin: number): number {
  let cursor = clamp(origin - 1, 0, Math.max(0, parts.length - 1))
  while (cursor > 0 && category(parts[cursor]) === "space") cursor--
  const kind = category(parts[cursor])
  while (cursor > 0 && category(parts[cursor - 1]) === kind) cursor--
  return cursor
}

function wordEnd(parts: readonly string[], origin: number): number {
  if (parts.length === 0) return 0
  let cursor = clamp(origin, 0, parts.length - 1)
  const current = category(parts[cursor])
  if (current !== "space" && cursor + 1 < parts.length && category(parts[cursor + 1]) === current) {
    while (cursor + 1 < parts.length && category(parts[cursor + 1]) === current) cursor++
    return cursor
  }
  cursor++
  while (cursor < parts.length && category(parts[cursor]) === "space") cursor++
  if (cursor >= parts.length) return parts.length - 1
  const kind = category(parts[cursor])
  while (cursor + 1 < parts.length && category(parts[cursor + 1]) === kind) cursor++
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

function moveOnce(parts: readonly string[], offset: number, motion: ComposerMotion): number {
  const start = lineStart(parts, offset)
  const end = lineEnd(parts, offset)
  switch (motion) {
    case "left": return Math.max(start, offset - 1)
    case "right": return normalLineTarget(parts, start, end, offset - start + 1)
    case "line-start": return start
    case "first-content": return firstContent(parts, offset)
    case "line-end": return end > start ? end - 1 : start
    case "word-forward": return wordForward(parts, offset)
    case "word-backward": return wordBackward(parts, offset)
    case "word-end": return wordEnd(parts, offset)
    case "up": {
      if (start === 0) return offset
      const previousEnd = start - 1
      const previousStart = lineStart(parts, previousEnd)
      return normalLineTarget(parts, previousStart, previousEnd, offset - start)
    }
    case "down": {
      if (end >= parts.length) return offset
      const nextStart = end + 1
      return normalLineTarget(parts, nextStart, lineEnd(parts, nextStart), offset - start)
    }
    case "document-start": return targetLine(parts, 1)
    case "document-end": return lastLine(parts)
  }
}

function moveBuffer(buffer: ComposerBuffer, motion: ComposerMotion, count: number, select: boolean): ComposerBuffer {
  const parts = split(buffer.text)
  const origin = clamp(buffer.cursorOffset, 0, parts.length)
  let target = origin
  if (motion === "document-start") target = targetLine(parts, Math.max(1, count))
  else if (motion === "document-end" && count > 0) target = targetLine(parts, count)
  else if (motion === "up" || motion === "down") {
    const column = origin - lineStart(parts, origin)
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
        target = normalLineTarget(parts, nextStart, lineEnd(parts, nextStart), column)
      }
    }
  } else {
    for (let step = 0; step < Math.max(1, count); step++) target = moveOnce(parts, target, motion)
  }
  return {
    text: buffer.text,
    cursorOffset: target,
    selection: select ? { anchor: buffer.selection?.anchor ?? origin, head: target } : undefined,
  }
}

function replace(parts: readonly string[], from: number, to: number, inserted: readonly string[]): string[] {
  return [...parts.slice(0, from), ...inserted, ...parts.slice(to)]
}

function normalCursor(parts: readonly string[], desired: number): number {
  if (parts.length === 0) return 0
  const bounded = clamp(desired, 0, parts.length - 1)
  const start = lineStart(parts, bounded)
  const end = lineEnd(parts, bounded)
  return normalLineTarget(parts, start, end, bounded - start)
}

function deleteCharacters(buffer: ComposerBuffer, count: number): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  const end = Math.min(lineEnd(parts, cursor), cursor + Math.max(1, count))
  if (cursor >= end) return { buffer }
  const register = { text: parts.slice(cursor, end).join(""), shape: "character" as const }
  const next = replace(parts, cursor, end, [])
  return { buffer: { text: next.join(""), cursorOffset: normalCursor(next, cursor) }, register }
}

function deleteLines(buffer: ComposerBuffer, count: number): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const start = lineStart(parts, buffer.cursorOffset)
  let end = start
  for (let line = 0; line < Math.max(1, count); line++) {
    end = lineEnd(parts, end)
    if (end < parts.length) end++
    else break
  }
  const registerEnd = end > start && parts[end - 1] === "\n" ? end - 1 : end
  const register = { text: parts.slice(start, registerEnd).join(""), shape: "line" as const }
  const removalStart = end === parts.length && start > 0 && parts[start - 1] === "\n" ? start - 1 : start
  const next = replace(parts, removalStart, end, [])
  return { buffer: { text: next.join(""), cursorOffset: normalCursor(next, start) }, register }
}

function deleteToLineEnd(buffer: ComposerBuffer, count: number, insertMode: boolean): { buffer: ComposerBuffer; register?: VimRegister } {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  let end = lineEnd(parts, cursor)
  for (let line = 1; line < Math.max(1, count) && end < parts.length; line++) end = lineEnd(parts, end + 1)
  if (cursor >= end) return { buffer }
  const register = { text: parts.slice(cursor, end).join(""), shape: "character" as const }
  const next = replace(parts, cursor, end, [])
  return {
    buffer: { text: next.join(""), cursorOffset: insertMode ? Math.min(cursor, next.length) : normalCursor(next, cursor) },
    register,
  }
}

function enterInsert(buffer: ComposerBuffer, placement: "before" | "after" | "line-start" | "line-end"): ComposerBuffer {
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  const end = lineEnd(parts, cursor)
  let target = cursor
  if (placement === "after") target = Math.min(cursor + 1, end)
  if (placement === "line-start") target = firstContent(parts, cursor)
  if (placement === "line-end") target = end
  return { text: buffer.text, cursorOffset: target }
}

function openLine(buffer: ComposerBuffer, placement: "above" | "below", count: number): ComposerBuffer {
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
  return { text: next.join(""), cursorOffset: end < parts.length ? position : position + 1 }
}

function paste(buffer: ComposerBuffer, register: VimRegister, placement: "before" | "after", count: number): ComposerBuffer {
  if (!register.text) return buffer
  const parts = split(buffer.text)
  const cursor = clamp(buffer.cursorOffset, 0, parts.length)
  if (register.shape === "character") {
    const inserted = split(register.text.repeat(Math.max(1, count)))
    const position = placement === "after" ? Math.min(cursor + 1, lineEnd(parts, cursor)) : cursor
    const next = replace(parts, position, position, inserted)
    return { text: next.join(""), cursorOffset: position + Math.max(0, inserted.length - 1) }
  }
  const payload = Array(Math.max(1, count)).fill(register.text).join("\n")
  const inserted = split(payload)
  const start = lineStart(parts, cursor)
  const end = lineEnd(parts, cursor)
  if (placement === "before") {
    const next = replace(parts, start, start, [...inserted, "\n"])
    return { text: next.join(""), cursorOffset: start + firstContent(inserted, 0) }
  }
  if (end < parts.length) {
    const position = end + 1
    const next = replace(parts, position, position, [...inserted, "\n"])
    return { text: next.join(""), cursorOffset: position + firstContent(inserted, 0) }
  }
  const separator = parts.length > 0 ? ["\n"] : []
  const next = replace(parts, end, end, [...separator, ...inserted])
  return { text: next.join(""), cursorOffset: end + separator.length + firstContent(inserted, 0) }
}

function yank(buffer: ComposerBuffer, register: VimRegister): ComposerBufferResult {
  if (!buffer.selection) return { buffer, register }
  const parts = split(buffer.text)
  const from = Math.min(buffer.selection.anchor, buffer.selection.head)
  const to = Math.max(buffer.selection.anchor, buffer.selection.head) + 1
  const text = parts.slice(from, to).join("")
  const nextRegister = { text, shape: "character" as const }
  return { buffer: { text: buffer.text, cursorOffset: buffer.cursorOffset }, register: nextRegister, effect: { type: "copy", text } }
}

/** Applies semantic Vim behavior to a grapheme-indexed composer buffer. */
export function applyComposerVimAction(
  buffer: ComposerBuffer,
  action: ComposerVimAction,
  register: VimRegister = { text: "", shape: "character" },
): ComposerBufferResult {
  if (action.type === "motion") return { buffer: moveBuffer(buffer, action.motion, action.count, action.select), register }
  if (action.type === "enter-insert") return { buffer: enterInsert(buffer, action.placement), register }
  if (action.type === "open-line") return { buffer: openLine(buffer, action.placement, action.count), register }
  if (action.type === "paste") return { buffer: paste(buffer, register, action.placement, action.count), register }
  if (action.type === "begin-visual") {
    return { buffer: { ...buffer, selection: { anchor: buffer.cursorOffset, head: buffer.cursorOffset } }, register }
  }
  if (action.type === "clear-selection") return { buffer: { text: buffer.text, cursorOffset: buffer.cursorOffset }, register }
  if (action.type === "yank") return yank(buffer, register)
  if (action.type === "submit") return { buffer, register, effect: { type: "submit" } }
  if (action.type === "retry") return { buffer, register, effect: { type: "retry" } }
  if (action.operator === "undo" || action.operator === "redo") {
    return { buffer, register, effect: { type: "history", direction: action.operator } }
  }
  const changed = action.operator === "delete-char"
    ? deleteCharacters(buffer, action.count)
    : action.operator === "delete-line"
      ? deleteLines(buffer, action.count)
      : deleteToLineEnd(buffer, action.count, action.enterInsert ?? false)
  return { buffer: changed.buffer, register: changed.register ?? register }
}

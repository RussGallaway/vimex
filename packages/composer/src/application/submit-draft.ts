import type {
  ComposerState,
  ImageAttachment,
  MentionAttachment,
  OutgoingMessage,
} from "../domain/composer-state"
import type { SubmissionIntent } from "../domain/submission-intent"
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const graphemes = (text: string) => [...segmenter.segment(text)]
const codeUnitAt = (text: string, offset: number) =>
  graphemes(text)[Math.max(0, offset)]?.index ?? text.length
const count = (text: string) => graphemes(text).length
export function submitDraft(
  state: ComposerState,
  intent: SubmissionIntent,
  queued: boolean,
  id: string,
): ComposerState {
  const text = state.text.trim()
  if (
    (!text && state.images.length === 0 && state.mentions.length === 0) ||
    state.outbox.some((message) => message.id === id)
  )
    return state
  return {
    ...state,
    text: "",
    images: [],
    mentions: [],
    cursorOffset: 0,
    revision: state.revision + 1,
    outbox: [
      ...state.outbox,
      {
        id,
        text,
        ...(state.images.length ? { images: state.images } : {}),
        ...(state.mentions.length ? { mentions: state.mentions } : {}),
        intent,
        status: queued ? "queued" : "sending",
      },
    ],
  }
}
export function attachImage(
  state: ComposerState,
  image: ImageAttachment,
  cursorOffset = state.cursorOffset,
): ComposerState {
  if (state.images.some((existing) => existing.id === image.id)) return state
  let number = 1
  while (
    state.text.includes(`[Image ${number}]`) ||
    state.images.some((existing) => existing.marker === `[Image ${number}]`)
  )
    number++
  const marker = `[Image ${number}]`
  const offset = codeUnitAt(state.text, cursorOffset)
  const before = state.text.slice(0, offset)
  const after = state.text.slice(offset)
  const prefix = before && !/\s$/u.test(before) ? " " : ""
  const suffix = !after || !/^\s/u.test(after) ? " " : ""
  const inserted = `${prefix}${marker}${suffix}`
  return {
    ...state,
    text: before + inserted + after,
    cursorOffset: count(before + inserted),
    images: [...state.images, { ...image, marker }],
    revision: state.revision + 1,
  }
}
export function removeImage(state: ComposerState, id: string): ComposerState {
  const image = state.images.find((image) => image.id === id)
  if (!image) return state
  const marker = image.marker
  const position = marker ? state.text.indexOf(marker) : -1
  let before = position < 0 ? state.text : state.text.slice(0, position)
  let after = position < 0 ? "" : state.text.slice(position + marker!.length)
  if (position >= 0) {
    if (before.endsWith(" ") && after.startsWith(" ")) after = after.slice(1)
    else if (!before && after.startsWith(" ")) after = after.slice(1)
    else if (!after && before.endsWith(" ")) before = before.slice(0, -1)
  }
  const text = before + after
  return {
    ...state,
    text,
    cursorOffset: Math.min(state.cursorOffset, count(text)),
    images: state.images.filter((candidate) => candidate.id !== id),
    revision: state.revision + 1,
  }
}

export function attachMention(
  state: ComposerState,
  mention: MentionAttachment,
  cursorOffset = state.cursorOffset,
): ComposerState {
  if (
    state.mentions.some(
      (existing) =>
        existing.kind === mention.kind && existing.path === mention.path,
    )
  )
    return state
  const offset = codeUnitAt(state.text, cursorOffset)
  const before = state.text.slice(0, offset)
  const after = state.text.slice(offset)
  const prefix = before && !/\s$/u.test(before) ? " " : ""
  const suffix = !after || !/^\s/u.test(after) ? " " : ""
  const marker = `@${mention.name}`
  const inserted = `${prefix}${marker}${suffix}`
  return {
    ...state,
    text: before + inserted + after,
    cursorOffset: count(before + inserted),
    mentions: [...state.mentions, { ...mention, marker }],
    revision: state.revision + 1,
  }
}

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "image"; path: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string; path: string }
export function composerParts(
  text: string,
  images: readonly ImageAttachment[],
  mentions: readonly MentionAttachment[] = [],
): ComposerPart[] {
  const positions = [
    ...images.map((image) => ({
      image,
      index: image.marker ? text.indexOf(image.marker) : -1,
      kind: "image" as const,
    })),
    ...mentions.map((mention) => ({
      mention,
      index: mention.marker ? text.indexOf(mention.marker) : -1,
      kind: mention.kind,
    })),
  ]
    .flatMap((image) => {
      return image.index < 0 ? [] : [image]
    })
    .sort((left, right) => left.index - right.index)
  const parts: ComposerPart[] = []
  let offset = 0
  for (const entry of positions) {
    const { index } = entry
    if (index < offset) continue
    if (index > offset)
      parts.push({ type: "text", text: text.slice(offset, index) })
    if (entry.kind === "image") {
      parts.push({ type: "image", path: entry.image.path })
      offset = index + entry.image.marker!.length
    } else {
      parts.push({
        type: entry.kind === "skill" ? "skill" : "mention",
        name: entry.mention.name,
        path: entry.mention.path,
      })
      offset = index + entry.mention.marker!.length
    }
  }
  if (offset < text.length)
    parts.push({ type: "text", text: text.slice(offset) })
  for (const image of images.filter((image) => !image.marker)) {
    if (!parts.length && text) parts.push({ type: "text", text })
    parts.push({ type: "image", path: image.path })
  }
  for (const mention of mentions.filter((mention) => !mention.marker)) {
    if (!parts.length && text) parts.push({ type: "text", text })
    parts.push({
      type: mention.kind === "skill" ? "skill" : "mention",
      name: mention.name,
      path: mention.path,
    })
  }
  return parts
}
export function markOutgoingSending(
  state: ComposerState,
  id: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id
        ? { ...message, status: "sending", reason: undefined }
        : message,
    ),
  }
}
export function firstQueuedMessage(
  state: ComposerState,
  intent?: SubmissionIntent,
): OutgoingMessage | undefined {
  return state.outbox.find(
    (message) =>
      message.status === "queued" &&
      (intent === undefined || message.intent === intent),
  )
}
/** Take back a pending message without replacing an existing draft. */
export function unqueueOutgoing(
  state: ComposerState,
  id: string,
): ComposerState {
  const message = state.outbox.find(
    (candidate) => candidate.id === id && candidate.status === "queued",
  )
  if (!message || state.text || state.images.length || state.mentions.length)
    return state
  return {
    ...state,
    text: message.text,
    images: message.images ?? [],
    mentions: message.mentions ?? [],
    cursorOffset: count(message.text),
    revision: state.revision + 1,
    outbox: state.outbox.filter((candidate) => candidate.id !== id),
  }
}
export function removeQueuedOutgoing(
  state: ComposerState,
  id: string,
): ComposerState {
  if (
    !state.outbox.some(
      (message) => message.id === id && message.status === "queued",
    )
  )
    return state
  return {
    ...state,
    outbox: state.outbox.filter((message) => message.id !== id),
  }
}
export function retryOutgoing(
  state: ComposerState,
  id: string,
  queued: boolean,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id
        ? {
            ...message,
            status: queued ? "queued" : "sending",
            reason: undefined,
          }
        : message,
    ),
  }
}
export function acknowledgeOutgoing(
  state: ComposerState,
  id: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.filter((message) => message.id !== id),
  }
}
export function failOutgoing(
  state: ComposerState,
  id: string,
  reason: string,
): ComposerState {
  return {
    ...state,
    outbox: state.outbox.map((message) =>
      message.id === id ? { ...message, status: "failed", reason } : message,
    ),
  }
}

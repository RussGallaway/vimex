import type { SyntaxStyle } from "@opentui/core"
import type { ConversationItem } from "@vimex/conversation"
import { emberTide } from "../theme"

// OpenTUI retains nested list/quote child backgrounds on style updates.
// A theme switch is rare; rebuild the native Markdown subtree then, while
// retaining its stable public ID and semantic source coordinates.
const styleGenerations = new WeakMap<SyntaxStyle, number>()
let nextStyleGeneration = 0
function styleGeneration(style: SyntaxStyle): number {
  let generation = styleGenerations.get(style)
  if (generation === undefined) {
    generation = ++nextStyleGeneration
    styleGenerations.set(style, generation)
  }
  return generation
}

export type MarkdownConversationItem = Extract<
  ConversationItem,
  { markdown: string }
>

export function MarkdownMessage(props: {
  item: MarkdownConversationItem
  syntax: SyntaxStyle
  blockId?: string
}) {
  const suffix =
    props.blockId && props.blockId !== "root" ? `:${props.blockId}` : ""
  return (
    <markdown
      key={`${styleGeneration(props.syntax)}:${emberTide.background}:${emberTide.backgroundPanel}:${suffix}`}
      id={`markdown:${props.item.id}${suffix}`}
      content={props.item.markdown}
      syntaxStyle={props.syntax}
      streaming={props.item.status === "running"}
      internalBlockMode="top-level"
      tableOptions={{ style: "grid" }}
      conceal
      fg={
        props.item.kind === "reasoning"
          ? emberTide.textMuted
          : props.item.kind === "user"
            ? emberTide.text
            : emberTide.textSoft
      }
      bg={
        props.item.kind === "user"
          ? emberTide.backgroundPanel
          : emberTide.background
      }
    />
  )
}

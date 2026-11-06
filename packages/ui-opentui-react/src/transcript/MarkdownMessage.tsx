import { getTreeSitterClient, type SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import {
  navigationDetailExperimentEnabled,
  navigationDetailGate,
} from "./experiments/navigation-detail"
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
  const renderer = useRenderer()
  const deferredClient =
    navigationDetailExperimentEnabled && props.item.status !== "running"
      ? navigationDetailGate(renderer).client(getTreeSitterClient())
      : undefined
  const suffix =
    props.blockId && props.blockId !== "root" ? `:${props.blockId}` : ""
  return (
    <markdown
      key={`${styleGeneration(props.syntax)}:${emberTide.background}:${emberTide.userBackground ?? emberTide.backgroundPanel}:${suffix}`}
      id={`markdown:${props.item.id}${suffix}`}
      content={props.item.markdown}
      syntaxStyle={props.syntax}
      treeSitterClient={deferredClient}
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
          ? (emberTide.userBackground ?? emberTide.backgroundPanel)
          : emberTide.background
      }
    />
  )
}

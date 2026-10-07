import type { MentionCandidate, MentionKind } from "@vimex/conversation"
import { emberTide } from "../theme"

export function MentionDrawer(props: {
  kind: MentionKind | "grep"
  query: string
  choices: readonly MentionCandidate[]
  selected: number
  marked: ReadonlySet<string>
  hint?: string
}) {
  const windowSize = 5
  const start = Math.min(
    Math.max(0, props.selected - windowSize + 1),
    Math.max(0, props.choices.length - windowSize),
  )
  const visible = props.choices.slice(start, start + windowSize)
  return (
    <box
      id="mention-drawer"
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      zIndex={30}
      height={Math.max(3, visible.length + 2)}
      backgroundColor={emberTide.overlayBackground ?? emberTide.backgroundPanel}
      border={["left"]}
      borderColor={emberTide.blueBright}
      paddingX={1}
    >
      <text
        height={1}
        fg={emberTide.blueBright}
        bg={emberTide.overlayBackground ?? emberTide.backgroundPanel}
      >
        /
        {props.kind === "file"
          ? "files"
          : props.kind === "grep"
            ? "grep"
            : `${props.kind}s`}{" "}
        {props.query}
      </text>
      {visible.length ? (
        visible.map((choice, index) => {
          const absoluteIndex = start + index
          const active = absoluteIndex === props.selected
          const marked = props.marked.has(choice.path)
          return (
            <box
              key={`${choice.kind}:${choice.path}:${index}`}
              id={`mention-choice:${absoluteIndex}`}
              height={1}
              flexDirection="row"
              gap={1}
              backgroundColor={
                active
                  ? emberTide.selection
                  : (emberTide.overlayBackground ?? emberTide.backgroundPanel)
              }
            >
              <text
                width={3}
                fg={active ? emberTide.selectionText : emberTide.ember}
              >
                {marked ? "✓" : active ? "▸" : " "}
              </text>
              <text
                flexGrow={1}
                minWidth={0}
                wrapMode="none"
                truncate
                fg={active ? emberTide.selectionText : emberTide.text}
              >
                {choice.name}
              </text>
              <text
                width="35%"
                minWidth={0}
                wrapMode="none"
                truncate
                fg={active ? emberTide.selectionText : emberTide.textMuted}
              >
                {choice.detail ?? choice.path}
              </text>
            </box>
          )
        })
      ) : (
        <text height={1} fg={emberTide.textMuted}>
          No matching {props.kind}
        </text>
      )}
      <text
        height={1}
        fg={emberTide.textMuted}
        bg={emberTide.overlayBackground ?? emberTide.backgroundPanel}
        wrapMode="none"
        truncate
      >
        {props.hint ??
          "↑/↓ move · space mark · tab next · enter attach · esc cancel"}
      </text>
    </box>
  )
}

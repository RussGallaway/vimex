import type { TextareaRenderable } from "@opentui/core"
import type { ComposerState, SubmissionIntent } from "@vimex/composer"
import type { VimMode } from "@vimex/interaction"
import { codeUnitOffsetToGraphemeOffset, graphemeOffsetToCodeUnitOffset } from "@vimex/interaction"
import { useEffect, type RefObject } from "react"
import { emberTide } from "../theme"

export function Composer(props: {
  state: ComposerState
  mode: VimMode
  activeTurn: boolean
  maxHeight: number
  insertEnter: "newline" | "submit"
  busySubmit: "queue" | "steer"
  textareaRef: RefObject<TextareaRenderable | null>
  onChange(text: string, cursorOffset: number): void
  onSubmit(intent: SubmissionIntent): void
  onRetry?(id: string): void
}) {
  useEffect(() => {
    const textarea = props.textareaRef.current
    if (!textarea) return
    if (textarea.plainText !== props.state.text) textarea.setText(props.state.text)
    const cursorOffset = graphemeOffsetToCodeUnitOffset(props.state.text, props.state.cursorOffset)
    if (textarea.cursorOffset !== cursorOffset) textarea.cursorOffset = cursorOffset
  }, [props.state.revision, props.state.text, props.state.cursorOffset, props.textareaRef])

  const queued = props.state.outbox.filter((message) => message.status === "queued").length
  const failed = props.state.outbox.filter((message) => message.status === "failed")
  return (
    <box
      id="composer-shell"
      flexShrink={0}
      border={["top"]}
      borderColor={props.mode === "insert" ? emberTide.sage : emberTide.borderMuted}
      backgroundColor={emberTide.backgroundRaised}
      paddingTop={1}
      paddingX={2}
    >
      <textarea
        id="composer"
        ref={props.textareaRef}
        minHeight={1}
        maxHeight={props.maxHeight}
        wrapMode="word"
        placeholder="Message Codex…"
        placeholderColor={emberTide.textMuted}
        textColor={emberTide.textSoft}
        focusedTextColor={emberTide.text}
        backgroundColor={emberTide.backgroundRaised}
        focusedBackgroundColor={emberTide.backgroundRaised}
        cursorColor={emberTide.sage}
        keyBindings={[
          ...(props.insertEnter === "submit" ? [{ name: "return", action: "submit" } as const] : []),
          { name: "return", shift: true, action: "newline" },
        ]}
        onContentChange={() => {
          const textarea = props.textareaRef.current
          if (textarea) props.onChange(textarea.plainText, codeUnitOffsetToGraphemeOffset(textarea.plainText, textarea.cursorOffset))
        }}
        onCursorChange={() => {
          const textarea = props.textareaRef.current
          if (textarea) props.onChange(textarea.plainText, codeUnitOffsetToGraphemeOffset(textarea.plainText, textarea.cursorOffset))
        }}
        onSubmit={() => props.onSubmit(props.activeTurn && props.busySubmit === "steer" ? "steer" : "next-turn")}
      />
      <box height={1} flexDirection="row" justifyContent="space-between" marginTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={emberTide.textMuted}>{props.insertEnter === "submit" ? "enter send · shift↵ newline" : "enter newline · ctrl↵ send"}</text>
          {props.activeTurn ? <text fg={emberTide.amber}>ctrl↵ steer</text> : null}
          {queued > 0 ? <text fg={emberTide.blueBright}>{queued} queued</text> : null}
        </box>
        <text fg={emberTide.textMuted}>{props.state.text.length} chars</text>
      </box>
      {failed.map((message) => (
        <box key={message.id} flexDirection="row" justifyContent="space-between" backgroundColor={emberTide.backgroundPanel} paddingX={1}>
          <text fg={emberTide.red} wrapMode="word">failed: {message.reason ?? "send failed"} · {message.text}</text>
          <text fg={emberTide.amber}>R retry</text>
        </box>
      ))}
    </box>
  )
}

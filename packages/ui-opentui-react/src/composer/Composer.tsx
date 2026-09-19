import { usePaneGeometry } from "../side-chat/pane-geometry"
import { useKeyboard, useRenderer } from "@opentui/react"
import { CliRenderEvents, type TextareaRenderable } from "@opentui/core"
import type { ComposerState, SubmissionIntent } from "@vimex/composer"
import type { VimMode } from "@vimex/interaction"
import { codeUnitOffsetToGraphemeOffset, graphemeOffsetToCodeUnitOffset } from "@vimex/interaction"
import { useEffect, useRef, useState, type MutableRefObject, type RefObject, type ReactNode } from "react"
import { emberTide } from "../theme"

export function Composer(props: {
  expanded?: boolean
  interactive?: boolean
  visible?: boolean
  state: ComposerState
  mode: VimMode
  activeTurn: boolean
  drawer?: ReactNode
  model?: string
  reasoningEffort?: string
  maxHeight: number
  insertEnter: "newline" | "submit"
  busySubmit: "queue" | "steer"
  textareaRef: RefObject<TextareaRenderable | null>
  submitRef: MutableRefObject<((intent: SubmissionIntent) => void) | null>
  onChange(text: string, cursorOffset: number): void
  onSubmit(intent: SubmissionIntent): void | boolean
  onEscape?(): void
  onRetry?(id: string): void
}) {
  const renderer = useRenderer()
  const [wrappedRows, setWrappedRows] = useState(1)
  const synchronizing = useRef(false)
  const committedMode = useRef(props.mode)
  const nativeSubmitIntent = useRef<SubmissionIntent | undefined>(undefined)
  const submittedClearPending = useRef(false)

  useEffect(() => {
    committedMode.current = props.mode
  }, [props.mode])

  useKeyboard((event) => {
    if (props.interactive === false || !props.textareaRef.current?.focused) return
    if (event.ctrl && (event.name.toLowerCase() === "return" || event.name.toLowerCase() === "enter")) {
      nativeSubmitIntent.current = "steer"
    }
    const escape = event.name.toLowerCase() === "escape" || (event.name === "" && event.raw.startsWith("\u001b"))
    if (!escape || committedMode.current === "normal") return
    event.preventDefault()
    committedMode.current = "normal"
    props.onEscape?.()
  })

  useEffect(() => {
    const textarea = props.textareaRef.current
    if (!textarea) return
    if (submittedClearPending.current) {
      submittedClearPending.current = false
      if (props.state.text === "") return
    }
    synchronizing.current = true
    try {
      if (textarea.plainText !== props.state.text) textarea.setText(props.state.text)
      const cursorOffset = graphemeOffsetToCodeUnitOffset(props.state.text, props.state.cursorOffset)
      if (textarea.cursorOffset !== cursorOffset) textarea.cursorOffset = cursorOffset
    } finally {
      synchronizing.current = false
    }
  }, [props.state.revision, props.state.text, props.state.cursorOffset, props.textareaRef])

  const publishNativeDraft = () => {
    if (props.interactive === false || synchronizing.current) return
    const textarea = props.textareaRef.current
    if (!textarea) return
    const cursorOffset = codeUnitOffsetToGraphemeOffset(textarea.plainText, textarea.cursorOffset)
    if (textarea.plainText !== props.state.text || cursorOffset !== props.state.cursorOffset) {
      props.onChange(textarea.plainText, cursorOffset)
    }
  }

  const submitNativeDraft = (explicitIntent?: SubmissionIntent) => {
    const intent = explicitIntent ?? (props.activeTurn && props.busySubmit === "steer" ? "steer" : "next-turn")
    const textarea = props.textareaRef.current
    if (!textarea || textarea.plainText.trim().length === 0) {
      props.onSubmit(intent)
      return
    }

    // The native textarea can receive the next terminal bytes before React
    // renders the cleared domain draft. Publish its current value first so the
    // submission captures it, then clear the native buffer in the same event.
    publishNativeDraft()
    submittedClearPending.current = true
    if (props.onSubmit(intent) === false) {
      submittedClearPending.current = false
      return
    }
    synchronizing.current = true
    try {
      textarea.setText("")
      textarea.cursorOffset = 0
      textarea.clearSelection()
    } finally {
      synchronizing.current = false
    }
  }
  props.submitRef.current = submitNativeDraft

  const dimensions = usePaneGeometry()
  const compact = dimensions.height < 18
  const showSendHint = dimensions.width >= 72
  useEffect(() => {
    if (!props.expanded || props.visible === false) return
    const measure = () => {
      const textarea = props.textareaRef.current
      // virtualLineCount covers only the native viewport; total includes offscreen wrapped rows.
      if (textarea) setWrappedRows(Math.max(1, textarea.editorView.getTotalVirtualLineCount()))
    }
    measure()
    renderer.on(CliRenderEvents.FRAME, measure)
    renderer.requestRender()
    return () => { renderer.off(CliRenderEvents.FRAME, measure) }
  }, [props.expanded, props.textareaRef, props.visible, renderer])
  const inputHeight = Math.max(1, Math.min(props.maxHeight, props.expanded ? Math.max(compact ? 2 : 3, wrappedRows) : compact ? 2 : 3))
  const queued = props.state.outbox.filter((message) => message.status === "queued").length
  const failed = props.state.outbox.filter((message) => message.status === "failed")
  return (
    <box
      id="composer-shell"
      flexShrink={0}
      border={["left"]}
      borderColor={emberTide.blueBright}
      backgroundColor={emberTide.backgroundRaised}
      paddingTop={compact ? 0 : 1}
      paddingX={2}
    >
      {props.drawer}
      <textarea
        id="composer"
        ref={props.textareaRef}
        height={inputHeight}
        minHeight={inputHeight}
        maxHeight={inputHeight}
        wrapMode="word"
        placeholder="Message Codex…"
        placeholderColor={emberTide.textMuted}
        textColor={emberTide.textSoft}
        focusedTextColor={emberTide.text}
        backgroundColor={emberTide.backgroundRaised}
        focusedBackgroundColor={emberTide.backgroundRaised}
        cursorColor={emberTide.sage}
        cursorStyle={{ style: props.mode === "insert" ? "line" : "block", blinking: false }}
        keyBindings={[
          ...(props.insertEnter === "submit" ? [{ name: "return", action: "submit" } as const] : []),
          { name: "return", shift: true, action: "newline" },
        ]}
        onKeyDown={(event) => {
          if (event.ctrl && (event.name.toLowerCase() === "return" || event.name.toLowerCase() === "enter")) {
            nativeSubmitIntent.current = "steer"
          }
          if (props.interactive === false || committedMode.current !== "insert") event.preventDefault()
        }}
        onPaste={(event) => {
          if (props.interactive === false || committedMode.current !== "insert") event.preventDefault()
        }}
        onContentChange={publishNativeDraft}
        onCursorChange={publishNativeDraft}
        onSubmit={() => {
          if (props.interactive === false) return
          const intent = nativeSubmitIntent.current
          nativeSubmitIntent.current = undefined
          submitNativeDraft(intent)
        }}
      />
      <box height={1} flexDirection="row" gap={1} marginTop={compact ? 0 : 1} justifyContent="space-between">
        <box id="composer-metadata" flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={emberTide.blueBright}>Codex</text>
          <text fg={emberTide.textMuted}>·</text>
          <text fg={emberTide.textSoft} wrapMode="none" truncate>{props.model ?? "model —"}</text>
          <text fg={emberTide.textMuted}>·</text>
          <text fg={emberTide.textSoft} wrapMode="none" truncate>{props.reasoningEffort ?? "effort —"}</text>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          {queued > 0 ? <text fg={emberTide.blueBright}>{queued} queued</text> : null}
          {props.activeTurn && showSendHint ? <text fg={emberTide.amber}>ctrl↵ steer</text> : null}
          {showSendHint ? <text id="composer-send-hint" fg={emberTide.textMuted}>{props.insertEnter === "submit" ? "enter send · shift↵ newline" : "enter newline · ctrl↵ send"}</text> : null}
        </box>
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

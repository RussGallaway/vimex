import {
  CliRenderEvents,
  type InputRenderable,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { UserQuestionRequest } from "@vimex/approvals"
import { useEffect, useRef, type RefObject } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function QuestionOverlay(props: {
  request?: UserQuestionRequest
  source?: string
  questionIndex: number
  optionIndex: number
  answers: Readonly<Record<string, string | readonly string[]>>
  inputRef: RefObject<InputRenderable | null>
  onInput(value: string): void
  onSubmit(): void
}) {
  const renderer = useRenderer()
  const maskRef = useRef<TextRenderable>(null)
  const optionsRef = useRef<ScrollBoxRenderable>(null)
  const question = props.request?.questions[props.questionIndex]
  const answer = question ? props.answers[question.id] : undefined
  const value = typeof answer === "string" ? answer : ""
  useEffect(() => {
    const list = optionsRef.current
    if (!question?.options?.[props.optionIndex] || !list) return
    list.scrollChildIntoView(`question-option:${props.optionIndex}`)
    list.requestRender()
  }, [props.optionIndex, question?.id])
  useEffect(() => {
    if (!question?.secret || !props.inputRef.current) return
    if (props.inputRef.current.plainText !== value)
      props.inputRef.current.setText(value)
    props.inputRef.current.cursorOffset = [...value].length
  }, [props.inputRef, question?.id])
  useEffect(() => {
    if (!question?.secret) return
    const sync = () => {
      const next = props.inputRef.current?.value ?? ""
      if (maskRef.current)
        maskRef.current.content = "•".repeat([...next].length)
    }
    renderer.on(CliRenderEvents.FRAME, sync)
    return () => {
      renderer.off(CliRenderEvents.FRAME, sync)
    }
  }, [props.inputRef, question?.secret, renderer])
  return (
    <OverlayFrame title="Codex question" width={88}>
      {question ? (
        <>
          {props.source ? (
            <text flexShrink={0} fg={emberTide.textMuted}>
              From {props.source}
            </text>
          ) : null}
          <text flexShrink={0} fg={emberTide.textMuted}>
            {props.questionIndex + 1} / {props.request!.questions.length} ·{" "}
            {question.header}
          </text>
          <text flexShrink={0} marginTop={1} fg={emberTide.text}>
            <b>{question.question}</b>
          </text>
          {question.options?.length ? (
            <scrollbox
              ref={optionsRef}
              maxHeight={10}
              minHeight={1}
              marginTop={1}
            >
              {question.options.map((option, index) => (
                <box
                  id={`question-option:${index}`}
                  key={option.label}
                  flexShrink={0}
                  backgroundColor={
                    index === props.optionIndex
                      ? emberTide.selection
                      : undefined
                  }
                  paddingX={1}
                >
                  <text
                    fg={
                      index === props.optionIndex
                        ? emberTide.selectionText
                        : emberTide.textSoft
                    }
                  >
                    {index === props.optionIndex ? "› " : "  "}
                    {option.label}
                  </text>
                  {option.description ? (
                    <text fg={emberTide.textMuted}> {option.description}</text>
                  ) : null}
                </box>
              ))}
            </scrollbox>
          ) : null}
          {!question.options?.length || question.allowOther ? (
            question.secret ? (
              <box
                marginTop={1}
                height={2}
                backgroundColor={emberTide.backgroundPanel}
                paddingX={1}
              >
                <box height={1} flexDirection="row">
                  <text fg={emberTide.blueBright}>
                    {question.allowOther && question.options?.length
                      ? "Other: "
                      : "Answer: "}
                  </text>
                  <text ref={maskRef} fg={emberTide.text} />
                </box>
                <input
                  id="question-answer"
                  ref={props.inputRef}
                  focused
                  width="100%"
                  onInput={(next) => {
                    if (maskRef.current)
                      maskRef.current.content = "•".repeat([...next].length)
                  }}
                  textColor={emberTide.backgroundPanel}
                  focusedTextColor={emberTide.backgroundPanel}
                  cursorColor={emberTide.backgroundPanel}
                  backgroundColor={emberTide.backgroundPanel}
                  focusedBackgroundColor={emberTide.backgroundPanel}
                  onSubmit={props.onSubmit}
                />
              </box>
            ) : (
              <box
                marginTop={1}
                height={1}
                flexDirection="row"
                backgroundColor={emberTide.backgroundPanel}
                paddingX={1}
              >
                <text fg={emberTide.blueBright}>
                  {question.allowOther && question.options?.length
                    ? "Other: "
                    : "Answer: "}
                </text>
                <input
                  id="question-answer"
                  ref={props.inputRef}
                  focused
                  flexGrow={1}
                  value={value}
                  onInput={props.onInput}
                  onChange={props.onInput}
                  textColor={emberTide.text}
                  cursorColor={emberTide.blueBright}
                  backgroundColor={emberTide.backgroundPanel}
                  focusedBackgroundColor={emberTide.backgroundPanel}
                  onSubmit={props.onSubmit}
                />
              </box>
            )
          ) : null}
          <text flexShrink={0} marginTop={1} fg={emberTide.textMuted}>
            ↑/↓ choose · enter answer/next · esc keeps request pending
          </text>
        </>
      ) : (
        <text fg={emberTide.textMuted}>No unanswered questions</text>
      )}
    </OverlayFrame>
  )
}

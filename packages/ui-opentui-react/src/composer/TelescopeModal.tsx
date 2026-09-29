import type { MentionCandidate } from "@vimex/conversation"
import {
  pathToFiletype,
  type InputRenderable,
  type ScrollBoxRenderable,
  type SyntaxStyle,
} from "@opentui/core"
import { useEffect, useRef, type RefObject } from "react"
import { emberTide } from "../theme"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { formatPickerPath } from "./picker-path"

/** Centered Telescope-style picker surface for file and grep results.
 *
 * The existing MentionDrawer remains the lightweight inline `@` experience.
 * This surface is intended for explicit picker launches (leader mappings) and
 * keeps the prompt, result list, preview, and action hint visually grouped.
 */
export function TelescopeModal(props: {
  title: string
  query: string
  cwd?: string
  editing?: boolean
  onQuery?(value: string): void
  inputRef?: RefObject<InputRenderable | null>
  syntax: SyntaxStyle
  previewPath?: string
  previewScrollRef?: RefObject<ScrollBoxRenderable | null>
  choices: readonly MentionCandidate[]
  selected: number
  marked: ReadonlySet<string>
  preview?: string
  status?: string
  hint?: string
}) {
  const resultsScrollRef = useRef<ScrollBoxRenderable>(null)
  const dimensions = usePaneGeometry()
  useEffect(() => {
    resultsScrollRef.current?.scrollChildIntoView(
      `telescope-result-${props.selected}`,
    )
  }, [props.selected, props.choices, dimensions.height])
  // Keep the measurement used for pane widths in sync with the picker box.
  // Using a different ratio makes the result/detail columns wider than the
  // actual bordered surface on smaller terminals, which can clip the footer
  // and let long rows bleed into the preview divider.
  const showDetail = props.title === "Grep"
  const pickerWidth = Math.max(60, Math.floor(dimensions.width * 0.92))
  const resultsRatio = showDetail ? 0.42 : 0.4
  const resultsWidth =
    props.preview !== undefined
      ? Math.floor((pickerWidth - 2) * resultsRatio)
      : pickerWidth - 2
  const detailWidth = showDetail ? Math.floor(resultsWidth * 0.35) : 0
  const pathWidth = Math.max(8, resultsWidth - detailWidth - 6)
  return (
    <box
      id="telescope-modal"
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      zIndex={45}
      backgroundColor={`${emberTide.background}d8`}
    >
      <box
        id="telescope-picker"
        width="92%"
        minWidth={60}
        height="92%"
        minHeight={15}
        border
        borderStyle="single"
        borderColor={emberTide.blue}
        backgroundColor={emberTide.backgroundRaised}
      >
        <box
          flexGrow={1}
          flexBasis={0}
          flexDirection="row"
          minHeight={0}
          overflow="hidden"
        >
          <box
            id="telescope-results-pane"
            width={
              props.preview !== undefined
                ? showDetail
                  ? "42%"
                  : "40%"
                : "100%"
            }
            flexShrink={0}
            minWidth={0}
            flexDirection="column"
            border={props.preview !== undefined ? ["right", "top"] : ["top"]}
            borderColor={emberTide.borderMuted}
            title=" Results "
            titleColor={emberTide.textMuted}
            titleAlignment="center"
          >
            <scrollbox
              id="telescope-results"
              ref={resultsScrollRef}
              flexGrow={1}
              minHeight={0}
              contentOptions={{ paddingX: 1 }}
              verticalScrollbarOptions={{ visible: false }}
            >
              {props.choices.length ? (
                props.choices.map((choice, index) => {
                  const active = index === props.selected
                  const marked = props.marked.has(choice.path)
                  return (
                    <box
                      id={`telescope-result-${index}`}
                      key={`${choice.kind}:${choice.path}:${index}`}
                      height={1}
                      flexShrink={0}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={
                        active
                          ? emberTide.selection
                          : emberTide.backgroundRaised
                      }
                    >
                      <text
                        width={2}
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
                        {formatPickerPath(
                          choice.name,
                          pathWidth,
                          showDetail ? "" : props.query,
                          props.cwd,
                        )}
                      </text>
                      {showDetail ? (
                        <text
                          width="35%"
                          minWidth={0}
                          wrapMode="none"
                          truncate
                          fg={
                            active
                              ? emberTide.selectionText
                              : emberTide.textMuted
                          }
                        >
                          {choice.detail ? ` ${choice.detail}` : choice.path}
                        </text>
                      ) : null}
                    </box>
                  )
                })
              ) : (
                <text fg={emberTide.textMuted}>No matches</text>
              )}
            </scrollbox>
            <box
              height={3}
              flexShrink={0}
              border
              borderStyle="single"
              borderColor={emberTide.borderMuted}
              paddingX={1}
              title={` ${props.title} `}
              titleColor={emberTide.textMuted}
              titleAlignment="center"
            >
              <box height={1} flexDirection="row">
                <text fg={emberTide.blueBright} width={2}>
                  &gt;
                </text>
                {props.onQuery ? (
                  <input
                    id="telescope-query"
                    ref={props.inputRef}
                    focused={props.editing ?? true}
                    flexGrow={1}
                    value={props.query}
                    onInput={props.onQuery}
                    onKeyDown={(event) => {
                      if (!event.ctrl) return
                      const preview = props.previewScrollRef?.current
                      if (!preview) return
                      switch (event.name.toLowerCase()) {
                        case "e":
                          preview.scrollBy(1, "step")
                          event.preventDefault()
                          break
                        case "y":
                          preview.scrollBy(-1, "step")
                          event.preventDefault()
                          break
                        case "d":
                          preview.scrollBy(0.5, "viewport")
                          event.preventDefault()
                          break
                        case "u":
                          preview.scrollBy(-0.5, "viewport")
                          event.preventDefault()
                          break
                      }
                    }}
                    textColor={emberTide.text}
                    backgroundColor={emberTide.backgroundRaised}
                    focusedBackgroundColor={emberTide.backgroundRaised}
                  />
                ) : (
                  <text fg={emberTide.text}>{props.query}</text>
                )}
                {props.status ? (
                  <text fg={emberTide.textMuted}>{props.status}</text>
                ) : null}
              </box>
            </box>
          </box>
          {props.preview !== undefined ? (
            <box
              id="telescope-preview-pane"
              flexGrow={0}
              flexShrink={0}
              width={showDetail ? "58%" : "60%"}
              minWidth={0}
              minHeight={0}
              flexDirection="column"
              border={["top"]}
              borderColor={emberTide.border}
              title=" Preview "
              titleColor={emberTide.blue}
              titleAlignment="center"
            >
              {props.preview ? (
                <scrollbox
                  id="telescope-preview"
                  ref={props.previewScrollRef}
                  flexGrow={1}
                  minHeight={0}
                  marginBottom={1}
                  contentOptions={{ paddingX: 1 }}
                  verticalScrollbarOptions={{
                    // The preview is navigated with Ctrl-E/Y and Ctrl-D/U;
                    // hiding the track keeps the modal surface uncluttered.
                    visible: false,
                  }}
                >
                  <code
                    id="telescope-preview-content"
                    content={props.preview}
                    filetype={
                      props.previewPath
                        ? pathToFiletype(props.previewPath)
                        : undefined
                    }
                    syntaxStyle={props.syntax}
                    conceal={false}
                    wrapMode="none"
                    fg={emberTide.textSoft}
                    bg={emberTide.backgroundRaised}
                  />
                </scrollbox>
              ) : (
                <box flexGrow={1} minHeight={0} paddingX={1}>
                  <text fg={emberTide.textMuted}>No preview</text>
                </box>
              )}
            </box>
          ) : null}
        </box>
      </box>
    </box>
  )
}

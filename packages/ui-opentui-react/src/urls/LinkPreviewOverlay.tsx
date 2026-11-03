import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useBindings } from "@opentui/keymap/react"
import type { WorkbenchState } from "@vimex/workbench"
import { useEffect, useRef } from "react"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"
import { LinkActionButton } from "./LinkActionButton"

export function LinkPreviewOverlay(props: {
  preview: NonNullable<WorkbenchState["linkPreview"]>
  onClose(): void
}) {
  const scroll = useRef<ScrollBoxRenderable>(null)
  const renderer = useRenderer()
  const lines = (props.preview.content ?? "").split("\n").length
  const outOfRange =
    !props.preview.loading &&
    !props.preview.error &&
    (props.preview.line ?? 1) > lines
  useEffect(() => {
    if (props.preview.loading || props.preview.error) return
    const apply = () => {
      const target = scroll.current
      if (!target || target.scrollHeight < lines) return
      target.scrollTo(Math.max(0, Math.min(props.preview.line ?? 1, lines) - 1))
      renderer.off(CliRenderEvents.FRAME, apply)
    }
    renderer.on(CliRenderEvents.FRAME, apply)
    scroll.current?.requestRender()
    return () => {
      renderer.off(CliRenderEvents.FRAME, apply)
    }
  }, [
    renderer,
    props.preview.content,
    props.preview.line,
    props.preview.loading,
    props.preview.error,
    lines,
  ])
  useBindings(
    () => ({
      priority: 260,
      bindings: [
        ...["j", "down"].map((key) => ({
          key,
          cmd: () => scroll.current?.scrollBy(1, "step"),
        })),
        ...["k", "up"].map((key) => ({
          key,
          cmd: () => scroll.current?.scrollBy(-1, "step"),
        })),
        { key: "ctrl+d", cmd: () => scroll.current?.scrollBy(0.5, "viewport") },
        {
          key: "ctrl+u",
          cmd: () => scroll.current?.scrollBy(-0.5, "viewport"),
        },
      ],
    }),
    [],
  )
  const preview = props.preview
  return (
    <OverlayFrame title="File preview" width={110}>
      <text flexShrink={0} fg={emberTide.blueBright} wrapMode="word">
        {preview.machineId} · {preview.path}
        {preview.line ? `:${preview.line}` : ""}
      </text>
      {outOfRange ? (
        <text flexShrink={0} fg={emberTide.amber}>
          Line {preview.line} is beyond this file ({lines} lines); showing the
          end.
        </text>
      ) : null}
      <scrollbox
        id="link-preview-scroll"
        ref={scroll}
        height={14}
        marginTop={1}
        flexShrink={1}
        minHeight={3}
      >
        <text
          id="link-preview-content"
          fg={preview.error ? emberTide.red : emberTide.text}
          wrapMode="none"
        >
          {preview.loading
            ? "Loading…"
            : (preview.error ?? preview.content ?? "No preview available")}
        </text>
      </scrollbox>
      <box flexShrink={0} flexDirection="row" gap={2} marginTop={1}>
        <text fg={emberTide.textMuted}>j/k scroll · esc close</text>
        <LinkActionButton
          id="link-preview-close"
          label="Close"
          onActivate={props.onClose}
        />
      </box>
    </OverlayFrame>
  )
}

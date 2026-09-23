import {
  LinearScrollAccel,
  type ScrollBoxRenderable,
  type SyntaxStyle,
} from "@opentui/core"
import type { ConversationItem, ThreadSummary } from "@vimex/conversation"
import type { InteractionState } from "@vimex/interaction"
import {
  blockKey,
  type TranscriptActivityBatch,
  type TranscriptItemBlock,
  type TranscriptState,
  type TranscriptWindow,
} from "@vimex/transcript"
import { memo, useMemo, type RefObject } from "react"
import { selectedRangeForItem } from "./layout"
import { emberTide } from "../theme"
import { TranscriptNode } from "./TranscriptNode"
import { TurnActivity } from "./TurnActivity"
import { ActivityBatch } from "./ActivityBatch"
import { transcriptBlockRenderableId } from "./rendered-layout"

export interface TranscriptViewportProps {
  window: TranscriptWindow
  state: TranscriptState
  surface: InteractionState["surface"]
  syntax: SyntaxStyle
  themeRevision?: string
  agentSummaries?: Readonly<Record<string, ThreadSummary>>
  scrollRef: RefObject<ScrollBoxRenderable | null>
  onManualScroll?: () => void
}

export function sameTranscriptViewportProps(
  before: TranscriptViewportProps,
  after: TranscriptViewportProps,
): boolean {
  return (
    before.window === after.window &&
    before.state === after.state &&
    before.surface === after.surface &&
    before.syntax === after.syntax &&
    before.themeRevision === after.themeRevision &&
    before.agentSummaries === after.agentSummaries &&
    before.scrollRef === after.scrollRef &&
    before.onManualScroll === after.onManualScroll
  )
}

export const TranscriptViewport = memo(function TranscriptViewport(
  props: TranscriptViewportProps,
) {
  // Terminal wheel events already encode movement; deterministic deltas avoid
  // accelerating trackpad bursts into large, unexpected viewport jumps.
  const scrollAcceleration = useMemo(() => new LinearScrollAccel(), [])
  const cursorId = props.state.cursor?.itemId
  const activityPresentation = props.window.activityPresentation
  return (
    <scrollbox
      id="transcript"
      ref={props.scrollRef}
      flexGrow={1}
      minHeight={0}
      stickyScroll={props.state.viewport.kind === "tail"}
      scrollAcceleration={scrollAcceleration}
      onMouseScroll={(event) => {
        if (
          event.scroll?.direction !== "up" &&
          event.scroll?.direction !== "down"
        )
          return
        if (event.modifiers.shift) return
        if (props.scrollRef.current)
          props.scrollRef.current.stickyScroll = false
        props.onManualScroll?.()
        event.stopPropagation()
      }}
      stickyStart="bottom"
      viewportCulling
      contentOptions={{ paddingX: 2, paddingY: 1 }}
      verticalScrollbarOptions={{
        visible: false,
        trackOptions: {
          foregroundColor: emberTide.border,
          backgroundColor: emberTide.background,
        },
      }}
    >
      {!props.window.blocks.length ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={emberTide.textMuted}>Start a conversation</text>
        </box>
      ) : null}
      <box
        id="transcript-top-spacer"
        visible={props.window.topSpacerRows > 0}
        height={Math.max(1, props.window.topSpacerRows)}
        flexShrink={0}
      />
      {props.window.blocks.map((block) => {
        if ("turn" in block)
          return (
            <box
              key={`turn:${block.key.turnId}`}
              id={transcriptBlockRenderableId(block)}
              flexShrink={0}
            >
              <box height={1} flexShrink={0} />
              <TurnActivity
                turn={block.turn}
                themeRevision={props.themeRevision}
              />
              <box height={1} flexShrink={0} />
            </box>
          )
        if (!("item" in block)) return null
        const activity = activityPresentation[blockKey(block)]
        if (activity?.kind === "activity-hidden")
          return (
            <box
              key={`item:${block.key.itemId}:${block.key.blockId}`}
              id={transcriptBlockRenderableId(block)}
              visible={false}
              enableLayout={false}
            />
          )
        const folded = Boolean(props.state.folded[block.key.itemId])
        const current =
          cursorId === block.key.itemId && props.surface === "transcript"
        const selected = Boolean(
          selectedRangeForItem(props.state, block.key.itemId),
        )
        if (activity?.kind === "activity-lead")
          return (
            <ActivityBatchRow
              key={`batch:${activity.batch.key}`}
              renderableId={transcriptBlockRenderableId(block)}
              batch={activity.batch}
              current={current}
              selected={selected}
              followedByActivity={Boolean(activity.batch.followedByActivity)}
              themeRevision={props.themeRevision}
            />
          )
        return (
          <TranscriptRow
            key={`item:${block.key.itemId}:${block.key.blockId}`}
            renderableId={transcriptBlockRenderableId(block)}
            block={block}
            folded={folded}
            current={current}
            selected={selected}
            syntax={props.syntax}
            agentSummaries={
              block.renderItem.kind === "agent"
                ? props.agentSummaries
                : undefined
            }
          />
        )
      })}
      <box
        id="transcript-bottom-spacer"
        visible={props.window.bottomSpacerRows > 0}
        height={Math.max(1, props.window.bottomSpacerRows)}
        flexShrink={0}
      />
    </scrollbox>
  )
}, sameTranscriptViewportProps)

// Stable historical rows skip Markdown reconciliation during typing and scrolling.
const TranscriptRow = memo(function TranscriptRow(props: {
  renderableId: string
  block: TranscriptItemBlock
  folded: boolean
  current: boolean
  selected: boolean
  syntax: SyntaxStyle
  agentSummaries?: Readonly<Record<string, ThreadSummary>>
}) {
  const item = props.block.renderItem as ConversationItem
  const continues = Boolean(
    props.block.fragment &&
    props.block.fragment.index < props.block.fragment.count - 1,
  )
  const firstFragment =
    !props.block.fragment || props.block.fragment.index === 0
  const finalFragment =
    !props.block.fragment ||
    props.block.fragment.index === props.block.fragment.count - 1
  const markdownContinuation =
    props.block.fragment?.kind === "markdown" && !firstFragment
  return (
    <box id={props.renderableId} flexShrink={0}>
      <box
        flexShrink={0}
        border={["left"]}
        borderColor={
          props.selected
            ? emberTide.amber
            : props.current
              ? emberTide.blueBright
              : emberTide.borderMuted
        }
        paddingLeft={2}
        paddingRight={item.kind === "user" ? 2 : 0}
        paddingTop={item.kind === "user" && firstFragment ? 1 : 0}
        paddingBottom={item.kind === "user" && finalFragment ? 1 : 0}
        backgroundColor={
          item.kind === "user"
            ? emberTide.backgroundPanel
            : emberTide.background
        }
      >
        {markdownContinuation ? <box height={1} flexShrink={0} /> : null}
        <TranscriptNode
          item={item}
          sourceItem={props.block.item as ConversationItem}
          folded={props.folded}
          syntax={props.syntax}
          agentSummaries={props.agentSummaries}
          blockId={props.block.key.blockId}
          fragment={props.block.fragment}
        />
      </box>
      {continues || props.block.followedByActivity ? null : (
        <box height={1} flexShrink={0} />
      )}
    </box>
  )
})

const ActivityBatchRow = memo(function ActivityBatchRow(props: {
  renderableId: string
  batch: TranscriptActivityBatch
  current: boolean
  selected: boolean
  followedByActivity: boolean
  themeRevision?: string
}) {
  return (
    <box id={props.renderableId} flexShrink={0}>
      <box
        flexShrink={0}
        border={["left"]}
        borderColor={
          props.selected
            ? emberTide.amber
            : props.current
              ? emberTide.blueBright
              : emberTide.borderMuted
        }
        paddingLeft={2}
      >
        <ActivityBatch batch={props.batch} />
      </box>
      {props.followedByActivity ? null : <box height={1} flexShrink={0} />}
    </box>
  )
})

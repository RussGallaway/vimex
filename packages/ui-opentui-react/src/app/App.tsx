import { CliRenderEvents, type InputRenderable, type Renderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { initialComposer } from "@vimex/composer"
import { initialInteraction, resolveComposerKey, type ComposerVimAction, type InteractionState } from "@vimex/interaction"
import { graphemeCount, initialTranscript, selectedText, type TranscriptState } from "@vimex/transcript"
import { activeWorkspace } from "@vimex/workbench"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Composer } from "../composer/Composer"
import { Statusline } from "../statusline/Statusline"
import { TranscriptViewport } from "../transcript/TranscriptViewport"
import { defaultVimexUiSettings, type VimexAppProps } from "../contracts"
import { buildTranscriptLayout, movePoint, type TranscriptLayout } from "../transcript/layout"
import { measureRenderedTranscript, measuredPoint, topVisiblePoint } from "../transcript/rendered-layout"
import { createEmberTideSyntax, selectTheme } from "../theme"
import { commonBindings } from "../keymap/common-bindings"
import { normalBindings } from "../keymap/normal-bindings"
import { visualBindings } from "../keymap/visual-bindings"
import { insertBindings } from "../keymap/insert-bindings"
import { commandBindings } from "../keymap/command-bindings"
import type { VimBindingContext } from "../keymap/binding-context"
import { OverlayLayer } from "./OverlayLayer"
import { FullscreenShell } from "./FullscreenShell"
import { CommandLine } from "../composer/CommandLine"

const blankTranscript = initialTranscript()
const blankComposer = initialComposer()
const blankInteraction = initialInteraction()

type Motion = Parameters<typeof movePoint>[2]

function activeTurn(interaction: InteractionState, activeTurnId?: string): boolean {
  return Boolean(activeTurnId) && interaction.mode !== "command"
}

function selectableAt(renderable: Renderable, x: number, y: number): Renderable | undefined {
  for (const child of [...renderable.getChildren()].reverse()) {
    if (!("screenX" in child)) continue
    const candidate = child as Renderable
    if (x < candidate.screenX || y < candidate.screenY || x >= candidate.screenX + candidate.width || y >= candidate.screenY + candidate.height) continue
    const nested = selectableAt(candidate, x, y)
    if (nested) return nested
  }
  return renderable.selectable ? renderable : undefined
}

export function VimexApp({ state, controller, settings: settingsInput }: VimexAppProps) {
  const renderer = useRenderer()
  const settings = { ...defaultVimexUiSettings, ...settingsInput }
  selectTheme(settings.theme)
  const dimensions = useTerminalDimensions()
  const workspace = activeWorkspace(state)
  const transcript = workspace?.transcript ?? blankTranscript
  const composer = workspace?.composer ?? blankComposer
  const interaction = workspace?.interaction ?? blankInteraction
  const summary = state.activeThreadId ? state.summaries[state.activeThreadId] : undefined
  const items = transcript.order.flatMap((id) => {
    const item = workspace?.conversation.items[id]
    return item ? [item] : []
  })
  const syntax = useMemo(() => createEmberTideSyntax(), [settings.theme])
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const textareaRef = useRef<TextareaRenderable>(null)
  const commandRef = useRef<InputRenderable>(null)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [renderedLayout, setRenderedLayout] = useState<TranscriptLayout>()
  const layoutSignature = useRef("")
  const pendingScrollAnchor = useRef(false)
  const pendingRestore = useRef(false)
  const countRef = useRef(interaction.count)
  const composerInteractionRef = useRef(interaction)
  composerInteractionRef.current = interaction
  const initializedFolds = useRef(new Set<string>())
  const transcriptWidth = Math.max(8, dimensions.width - 7)
  const estimatedLayout = useMemo(() => buildTranscriptLayout(transcript, transcriptWidth), [transcript, transcriptWidth])
  const layout = renderedLayout ?? estimatedLayout
  const busy = activeTurn(interaction, workspace?.conversation.activeTurnId)
  const pendingApproval = state.approvals.order
    .map((id) => state.approvals.byId[id])
    .find((approval) => approval?.status === "pending" || approval?.status === "failed")
  const selectionCount = selectedText(transcript, "plain")

  useEffect(() => () => syntax.destroy(), [syntax])
  useEffect(() => { countRef.current = interaction.count }, [interaction.count])
  useEffect(() => {
    for (const item of items) {
      if (initializedFolds.current.has(item.id)) continue
      initializedFolds.current.add(item.id)
      if ((settings.foldReasoning && item.kind === "reasoning") || (settings.foldTools && (item.kind === "tool" || item.kind === "command" || item.kind === "edit"))) {
        controller.transcript({ type: "fold.set", itemId: item.id, folded: true })
      }
    }
  }, [controller, items, settings.foldReasoning, settings.foldTools])
  useEffect(() => {
    const measure = () => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      const next = measureRenderedTranscript(renderer, scrollbox, transcript)
      if (!next) return
      const signature = JSON.stringify(next.points)
      if (signature !== layoutSignature.current) {
        layoutSignature.current = signature
        setRenderedLayout(next)
      }
      if (pendingScrollAnchor.current) {
        pendingScrollAnchor.current = false
        const anchor = topVisiblePoint(next, scrollbox)
        if (anchor) controller.transcript({
          type: "cursor.move",
          target: { itemId: anchor.itemId, graphemeOffset: anchor.graphemeOffset },
          preferredScreenRow: 0,
          extend: false,
        })
      }
      if (pendingRestore.current && transcript.viewport.kind === "point") {
        const anchor = measuredPoint(next, transcript.viewport.point)
        if (anchor) {
          pendingRestore.current = false
          const delta = anchor.screenY - scrollbox.viewport.screenY - transcript.viewport.preferredScreenRow
          if (delta) scrollbox.scrollBy(delta, "step")
        } else {
          scrollbox.scrollChildIntoView(`transcript-item:${transcript.viewport.point.itemId}`)
        }
      }
    }
    renderer.on(CliRenderEvents.FRAME, measure)
    renderer.requestRender()
    return () => { renderer.off(CliRenderEvents.FRAME, measure) }
  }, [controller, renderer, transcript])
  const geometryRevision = `${dimensions.width}:${dimensions.height}:${Object.keys(transcript.folded).join(",")}:${transcript.order.map((id) => transcript.projectionById[id]?.revision ?? 0).join(",")}`
  useEffect(() => {
    if (transcript.viewport.kind === "point") pendingRestore.current = true
  }, [geometryRevision])
  useEffect(() => setOverlayIndex(0), [interaction.overlay])
  useEffect(() => {
    if (interaction.overlay) {
      textareaRef.current?.blur()
      commandRef.current?.blur()
    } else if (interaction.mode === "insert") {
      textareaRef.current?.focus()
    } else if (interaction.mode === "command") {
      commandRef.current?.focus()
    } else if (interaction.surface === "composer") {
      commandRef.current?.blur()
      textareaRef.current?.focus()
    } else {
      textareaRef.current?.blur()
      commandRef.current?.blur()
      scrollRef.current?.focus()
    }
  }, [interaction.mode, interaction.overlay, interaction.surface])
  useEffect(() => {
    if (interaction.surface !== "transcript") {
      renderer.clearSelection()
      return
    }
    const anchorPoint = transcript.selection?.anchor ?? transcript.cursor
    const headPoint = transcript.selection?.head ?? transcript.cursor
    const anchor = measuredPoint(layout, anchorPoint)
    const head = measuredPoint(layout, headPoint)
    const scrollbox = scrollRef.current
    if (!anchor || !head || !scrollbox) return
    const anchorItem = scrollbox.getRenderable(`transcript-item:${anchor.itemId}`)
    const headItem = scrollbox.getRenderable(`transcript-item:${head.itemId}`)
    const anchorTarget = anchorItem ? selectableAt(anchorItem, anchor.screenX, anchor.screenY) : undefined
    const headTarget = headItem ? selectableAt(headItem, head.screenX, head.screenY) : undefined
    if (!anchorTarget || !headTarget) return
    renderer.startSelection(anchorTarget, anchor.screenX, anchor.screenY, transcript.selection?.shape === "line" ? "line" : "cell")
    renderer.updateSelection(headTarget, head.screenX, head.screenY, { finishDragging: true })
  }, [interaction.surface, layout, renderer, transcript.cursor, transcript.selection])
  useEffect(() => {
    if (interaction.surface === "transcript" && transcript.cursor) {
      scrollRef.current?.scrollChildIntoView(`transcript-item:${transcript.cursor.itemId}`)
    }
  }, [interaction.surface, transcript.cursor?.itemId, transcript.cursor?.graphemeOffset])

  const dispatchMotion = useCallback((motion: Motion, repeat = 1) => {
    let point = transcript.cursor
    let result: ReturnType<typeof movePoint>
    for (let index = 0; index < repeat; index += 1) {
      result = movePoint(layout, point, motion)
      if (!result) return
      point = result.point
    }
    if (result) controller.transcript({
      type: "cursor.move",
      target: result.point,
      preferredScreenRow: (() => {
        const measured = measuredPoint(layout, result.point)
        return measured && scrollRef.current ? measured.screenY - scrollRef.current.viewport.screenY : result.preferredScreenRow
      })(),
      extend: interaction.mode === "visual",
    })
  }, [controller, interaction.mode, layout, transcript.cursor])
  const countedMotion = useCallback((motion: Motion) => {
    dispatchMotion(motion, countRef.current ? Math.max(1, Number.parseInt(countRef.current, 10)) : 1)
    countRef.current = ""
    controller.dispatchInteraction({ type: "count.clear" })
  }, [controller, dispatchMotion])

  const applyComposerAction = useCallback((action: ComposerVimAction) => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (action.type === "motion") {
      for (let index = 0; index < action.count; index += 1) {
        const select = action.select ? { select: true } : undefined
        switch (action.motion) {
          case "left": textarea.moveCursorLeft(select); break
          case "right": textarea.moveCursorRight(select); break
          case "up": textarea.moveCursorUp(select); break
          case "down": textarea.moveCursorDown(select); break
          case "word-forward": textarea.moveWordForward(select); break
          case "word-backward": textarea.moveWordBackward(select); break
          case "line-start": textarea.gotoVisualLineHome(select); break
          case "line-end": textarea.gotoVisualLineEnd(select); break
        }
      }
      controller.changeDraft(textarea.plainText, textarea.cursorOffset)
    } else if (action.type === "edit") {
      for (let index = 0; index < action.count; index += 1) {
        if (action.operator === "delete-char") textarea.deleteChar()
        if (action.operator === "delete-line") textarea.deleteLine()
        if (action.operator === "undo") textarea.undo()
        if (action.operator === "redo") textarea.redo()
      }
      controller.changeDraft(textarea.plainText, textarea.cursorOffset)
    } else if (action.type === "enter-insert") {
      if (action.placement === "after") textarea.moveCursorRight()
      if (action.placement === "line-start") textarea.gotoLineHome()
      if (action.placement === "line-end") textarea.gotoLineEnd()
    } else if (action.type === "begin-visual") {
      textarea.setSelectionInclusive(textarea.cursorOffset, textarea.cursorOffset)
    } else if (action.type === "clear-selection") {
      textarea.clearSelection()
    } else if (action.type === "yank") {
      const text = textarea.getSelectedText()
      if (text) controller.copyText(text)
      textarea.clearSelection()
    } else if (action.type === "retry") {
      const failed = composer.outbox.find((message) => message.status === "failed")
      if (failed) controller.retryOutgoing(failed.id)
    }
  }, [composer.outbox, controller])
  const runComposerKey = useCallback((key: string) => {
    const resolution = resolveComposerKey(composerInteractionRef.current, key)
    composerInteractionRef.current = resolution.state
    if (resolution.action) applyComposerAction(resolution.action)
    for (const command of resolution.commands) controller.dispatchInteraction(command)
  }, [applyComposerAction, controller])

  const scroll = useCallback((direction: "up" | "down", amount: "line" | "half-page") => {
    const delta = direction === "down" ? 1 : -1
    scrollRef.current?.scrollBy(delta * (amount === "line" ? 1 : 0.5), amount === "line" ? "step" : "viewport")
    pendingScrollAnchor.current = true
    controller.transcript({ type: "viewport.scroll", direction, amount })
  }, [controller])

  const beginVisual = useCallback((shape: "character" | "line") => {
    if (!transcript.cursor) dispatchMotion("last")
    controller.transcript({ type: "selection.begin", shape })
    controller.dispatchInteraction({ type: "mode.visual" })
  }, [controller, dispatchMotion, transcript.cursor])

  const closeOverlay = useCallback(() => controller.dispatchInteraction({ type: "overlay.close" }), [controller])
  const openOverlay = useCallback((overlay: "sessions" | "approvals" | "help") => {
    controller.dispatchInteraction({ type: "overlay.open", overlay })
  }, [controller])

  const bindingContext: VimBindingContext = {
    interaction, transcript, composer, controller, countRef, textareaRef, scrollRef,
    countedMotion, dispatchMotion, runComposerKey, beginVisual, openOverlay, scroll,
  }
  useBindings(() => ({
    priority: 100,
    bindings: interaction.overlay ? [] : [
      ...commonBindings(bindingContext),
      ...(interaction.mode === "normal" ? normalBindings(bindingContext) : []),
      ...(interaction.mode === "visual" ? visualBindings(bindingContext) : []),
      ...(interaction.mode === "insert" ? insertBindings(bindingContext) : []),
      ...(interaction.mode === "command" ? commandBindings(bindingContext) : []),
      ...Object.entries(settings.keybindings).map(([key, command]) => ({ key, cmd: () => controller.executeCommand(command) })),
    ],
  }), [bindingContext, settings.keybindings])

  useBindings(() => ({
    priority: 200,
    bindings: !interaction.overlay ? [] : [
      { key: "escape", cmd: closeOverlay },
      { key: "?", cmd: closeOverlay },
      { key: "j", cmd: () => setOverlayIndex((value) => value + 1) },
      { key: "k", cmd: () => setOverlayIndex((value) => Math.max(0, value - 1)) },
      { key: "return", cmd: () => {
        if (interaction.overlay === "sessions") {
          const id = state.threadOrder[Math.min(overlayIndex, Math.max(0, state.threadOrder.length - 1))]
          if (id) controller.openThread(id)
        } else if (interaction.overlay === "approvals" && pendingApproval) {
          const choice = pendingApproval.choices[Math.min(overlayIndex, Math.max(0, pendingApproval.choices.length - 1))]
          if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
        }
        closeOverlay()
      } },
      ...Array.from({ length: 9 }, (_, index) => ({ key: `${index + 1}`, cmd: () => {
        if (interaction.overlay !== "approvals" || !pendingApproval) return
        const choice = pendingApproval.choices[index]
        if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
      } })),
    ],
  }), [interaction.overlay, closeOverlay, controller, overlayIndex, pendingApproval, state.threadOrder])

  return (
    <FullscreenShell title={summary?.title} connection={state.connection} working={summary?.status === "working"}
      transcript={<TranscriptViewport items={items} state={transcript} interaction={interaction} syntax={syntax} scrollRef={scrollRef} />}
      commandLine={interaction.mode === "command" ? <CommandLine value={interaction.commandLine} inputRef={commandRef} controller={controller} /> : undefined}
      composer={<Composer
        state={composer}
        mode={interaction.mode}
        activeTurn={busy}
        maxHeight={Math.max(3, Math.floor(dimensions.height * Math.max(0.1, Math.min(0.6, settings.composerMaxHeight))))}
        insertEnter={settings.insertEnter}
        busySubmit={settings.busySubmit}
        textareaRef={textareaRef}
        onChange={controller.changeDraft}
        onSubmit={controller.submit}
        onRetry={controller.retryOutgoing}
      />}
      statusline={<Statusline
        mode={interaction.mode}
        summary={summary}
        pendingKeys={interaction.pendingKeys}
        unseenEntries={transcript.unseenEntries}
        selectionCount={selectionCount ? graphemeCount(selectionCount) : undefined}
        pendingApprovals={state.approvals.order.length}
        activeTurn={busy}
      />}
      overlay={<OverlayLayer
        overlay={interaction.overlay}
        threads={state.threadOrder}
        summaries={state.summaries}
        activeThreadId={state.activeThreadId}
        approval={pendingApproval}
        selected={overlayIndex}
      />}
    />
  )
}

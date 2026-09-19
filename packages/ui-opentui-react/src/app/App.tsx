import { NoticeStrip } from "../statusline/NoticeStrip"
import { usePaneGeometry } from "../side-chat/pane-geometry"
import { FlashJump } from "../transcript/FlashJump"
import { CliRenderEvents, type InputRenderable, type Renderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { flushSync, useRenderer } from "@opentui/react"
import { initialComposer, type SubmissionIntent } from "@vimex/composer"
import { applyComposerVimAction, codeUnitOffsetToGraphemeOffset, commandCompletions, graphemeOffsetToCodeUnitOffset, initialCommandHistory, initialInteraction, recallCommand, recordCommand, resolveComposerKey, type ComposerVimAction, type InteractionState } from "@vimex/interaction"
import { initialTranscript, selectedGraphemeCount, type TranscriptRuntimeInput, type TranscriptState, type TranscriptWindow } from "@vimex/transcript"
import { activeWorkspace, liveActivity, sideChatForChild } from "@vimex/workbench"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Composer } from "../composer/Composer"
import { SlashCommandDrawer } from "../composer/SlashCommandDrawer"
import { useSlashCommands } from "../composer/use-slash-commands"
import { Statusline } from "../statusline/Statusline"
import { useTranscriptLayout } from "../transcript/use-transcript-layout"
import { TranscriptViewport } from "../transcript/TranscriptViewport"
import { defaultVimexUiSettings, type VimexAppProps } from "../contracts"
import { materializedSelectionEndpoints, movePoint, movePointInTranscript, type TranscriptLayout } from "../transcript/layout"
import { measureRenderedTranscript, measuredPoint, transcriptRenderableIdForPoint } from "../transcript/rendered-layout"
import { createEmberTideSyntax, selectTheme } from "../theme"
import { commonBindings } from "../keymap/common-bindings"
import { normalBindings } from "../keymap/normal-bindings"
import { visualBindings } from "../keymap/visual-bindings"
import { insertBindings } from "../keymap/insert-bindings"
import { commandBindings } from "../keymap/command-bindings"
import type { VimBindingContext } from "../keymap/binding-context"
import { OverlayLayer } from "./OverlayLayer"
import { FullscreenShell } from "./FullscreenShell"
import { commandBody, commandPrompt, CommandLine } from "../composer/CommandLine"
import { searchSessions } from "../sessions/session-search"
import { agentNavigationRows } from "../agents/AgentsOverlay"
import { useTranscriptRuntime } from "../transcript/use-transcript-runtime"

const blankTranscript = initialTranscript()
const blankTranscriptWindow: TranscriptWindow = Object.freeze({ blocks: Object.freeze([]), topSpacerRows: 0, bottomSpacerRows: 0, overscanRows: 0 })
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

export function VimexApp({ state, controller, settings: settingsInput, paneLabel, presentationId = "main", interactive = true, presentationVisible = true }: VimexAppProps) {
  const renderer = useRenderer()
  const distinctControlI = useSyncExternalStore(useCallback((notify: () => void) => {
    renderer.on(CliRenderEvents.CAPABILITIES, notify)
    return () => { renderer.off(CliRenderEvents.CAPABILITIES, notify) }
  }, [renderer]), () => Boolean(renderer.capabilities?.kitty_keyboard))
  const settings = { ...defaultVimexUiSettings, ...settingsInput, ...state.preferences }
  selectTheme(settings.theme, settings.reducedColor)
  const dimensions = usePaneGeometry()
  const workspace = activeWorkspace(state)
  const semanticTranscript = workspace?.transcript ?? blankTranscript
  const composer = workspace?.composer ?? blankComposer
  const interaction = workspace?.interaction ?? blankInteraction
  const parentLink = state.agentRelationships.find(link => link.childId === state.activeThreadId)
  const inheritedTurnIds = sideChatForChild(state, state.activeThreadId)?.inheritedTurnIds
  const parentTitle = parentLink ? state.summaries[parentLink.parentId]?.title || parentLink.parentId : undefined
  const summary = state.activeThreadId ? state.summaries[state.activeThreadId] : undefined
  const runtimeInput = useMemo<TranscriptRuntimeInput | undefined>(() => workspace && state.activeThreadId ? {
    threadId: state.activeThreadId,
    canonicalGeneration: workspace.canonicalGeneration,
    canonicalRevision: workspace.canonicalRevision,
    conversation: workspace.conversation,
    transcript: workspace.transcript,
    mode: workspace.transcript.viewport.kind === "tail" ? "follow" : "detached",
    canonicalDamage: { kind: "full" },
    excludedTurnIds: inheritedTurnIds,
  } : undefined, [inheritedTurnIds, state.activeThreadId, workspace])
  const transcriptFrame = useTranscriptRuntime(controller, presentationId, runtimeInput)
  const transcriptRuntime = controller.transcriptRuntime(presentationId)
  const transcript = workspace ? transcriptFrame.transcript : blankTranscript
  const transcriptWindow = workspace ? transcriptFrame.window : blankTranscriptWindow
  const transcriptStyleRevision = `${settings.theme}:${settings.syntaxTheme}:${settings.reducedColor ? 1 : 0}`
  const syntax = useMemo(() => createEmberTideSyntax(settings.syntaxTheme === "theme" ? settings.theme : settings.syntaxTheme, settings.reducedColor), [settings.reducedColor, settings.syntaxTheme, settings.theme])
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const textareaRef = useRef<TextareaRenderable>(null)
  const composerSubmitRef = useRef<((intent: SubmissionIntent) => void) | null>(null)
  const commandRef = useRef<InputRenderable>(null)
  const sessionSearchRef = useRef<InputRenderable>(null)
  const liveSessionQuery = useRef("")
  const questionInputRef = useRef<InputRenderable>(null)
  const commandHistoryRef = useRef(initialCommandHistory())
  const composerSelectionRef = useRef<{ anchor: number; head: number } | undefined>(undefined)
  const appliedNativeSelection = useRef<{
    token: object
    selection: NonNullable<TranscriptState["selection"]>
    scrollTop: number
    startRoot: Renderable
    endRoot: Renderable
    startTarget: Renderable
    endTarget: Renderable
    startX: number
    startY: number
    endX: number
    endY: number
  } | undefined>(undefined)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const overlayIndexRef = useRef(0)
  const [sessionQuery, setSessionQuery] = useState("")
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | readonly string[]>>({})
  const [modelPicker, setModelPicker] = useState<{ stage: "models" } | { stage: "efforts"; modelId: string }>({ stage: "models" })
  const [allSessions, setAllSessions] = useState(false)
  const sessionCwd = allSessions ? undefined : summary?.cwd
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const jumpActive = interactive && jumpOpen && !interaction.overlay
  useEffect(() => { setJumpOpen(false) }, [state.activeThreadId, dimensions.width, dimensions.height, interaction.overlay])
  const countRef = useRef(interaction.count)
  const composerInteractionRef = useRef(interaction)
  const composerThreadRef = useRef(state.activeThreadId)
  composerInteractionRef.current = interaction
  const { layout, measuredLayout, onManualScroll, enterVisibleTranscript } = useTranscriptLayout({
    threadId: state.activeThreadId,
    transcript,
    frame: transcriptFrame,
    runtime: transcriptRuntime,
    styleRevision: transcriptStyleRevision,
    width: dimensions.width,
    height: dimensions.height,
    scrollRef,
    controller,
    visible: presentationVisible,
    onAnchor: paneLabel || !interactive ? (point, row) => { if (state.activeThreadId) controller.anchorThread(state.activeThreadId, point, row) } : undefined,
  })
  const busy = activeTurn(interaction, workspace?.conversation.activeTurnId)
  const pendingApproval = state.approvals.order
    .map((id) => state.approvals.byId[id])
    .find((approval) => approval !== undefined && approval.threadId === state.activeThreadId && (approval.status === "pending" || approval.status === "failed"))
  const pendingQuestion = Object.values(state.questions).find((question) => question.threadId === state.activeThreadId)
  const activity = liveActivity(state)
  const activityLabel = pendingApproval ? "Approval needed" : pendingQuestion ? "Answer needed"
    : activity.label
  const sessionRows = useMemo(() => searchSessions(state.threadOrder, state.summaries, sessionQuery, state.favoriteThreadIds, sessionCwd), [sessionQuery, state.summaries, state.threadOrder, state.favoriteThreadIds, sessionCwd])
  const agentRows = useMemo(() => agentNavigationRows(state.activeThreadId, state.agentRelationships), [state.activeThreadId, state.agentRelationships])
  const selectionCount = useMemo(() => selectedGraphemeCount(transcript), [transcript.selection, transcript.order, transcript.projectionById])
  const selectedPickerModel = modelPicker.stage === "efforts" ? state.availableModels?.find(model => model.id === modelPicker.modelId) : undefined
  const overlayLength = interaction.overlay === "models" ? (modelPicker.stage === "efforts" ? (selectedPickerModel?.efforts.length ?? 0) : (state.availableModels?.length ?? 0))
    : interaction.overlay === "sessions" ? sessionRows.length
    : interaction.overlay === "approvals" ? (pendingApproval?.choices.length ?? 0)
      : interaction.overlay === "questions" ? (pendingQuestion?.questions[questionIndex]?.options?.length ?? 1)
        : interaction.overlay === "agents" ? agentRows.length
          : interaction.overlay === "urls" ? (state.urlChoices?.length ?? 0)
            : 1
  const activeQuestion = pendingQuestion?.questions[Math.min(questionIndex, Math.max(0, (pendingQuestion?.questions.length ?? 1) - 1))]
  const questionOwnsReturn = Boolean(activeQuestion && (!activeQuestion.options?.length || activeQuestion.allowOther))
  const slashCommands = useSlashCommands({ suspended: !interactive || jumpActive, text: composer.text, textareaRef, interaction, controller,
    completionOptions: { models: state.availableModels?.map(model => model.id),
      modelEfforts: Object.fromEntries(state.availableModels?.map(model => [model.id, model.efforts]) ?? []), currentModel: summary?.model, sessionIds: state.threadOrder },
    onExecute(command) {
    commandHistoryRef.current = recordCommand(commandHistoryRef.current, command)
    controller.executeCommand(command, presentationId)
  } })

  useEffect(() => () => syntax.destroy(), [syntax])
  useEffect(() => { countRef.current = interaction.count }, [interaction.count])
  useEffect(() => {
    const switchedThread = composerThreadRef.current !== state.activeThreadId
    composerThreadRef.current = state.activeThreadId
    if (!switchedThread && interaction.mode === "visual" && interaction.surface === "composer") return
    composerSelectionRef.current = undefined
    textareaRef.current?.clearSelection()
  }, [interaction.mode, interaction.surface, state.activeThreadId])
  useEffect(() => {
    if (!interactive) return
    controller.transcript({ type: "fold.defaults", reasoning: settings.foldReasoning, tools: settings.foldTools })
  }, [interactive, controller, settings.foldReasoning, settings.foldTools, state.activeThreadId, semanticTranscript.order])
  useLayoutEffect(() => {
    overlayIndexRef.current = 0
    setOverlayIndex(0)
    if (interaction.overlay === "sessions") setAllSessions(false)
    if (interaction.overlay !== "models") setModelPicker({ stage: "models" })
    if (interaction.overlay !== "sessions") {
      liveSessionQuery.current = ""
      setSessionQuery("")
    }
  }, [interaction.overlay])
  useEffect(() => { setQuestionIndex(0); setQuestionAnswers({}) }, [pendingQuestion?.id])
  useEffect(() => {
    if (!interactive) return
    if (state.pendingFork && interaction.overlay !== "fork") controller.dispatchInteraction({ type: "overlay.open", overlay: "fork" })
    else if (!state.pendingFork && pendingQuestion && !interaction.overlay) controller.dispatchInteraction({ type: "overlay.open", overlay: "questions" })
  }, [interactive, controller, interaction.overlay, pendingQuestion, state.pendingFork])
  useEffect(() => {
    if (!interactive) {
      textareaRef.current?.blur(); commandRef.current?.blur(); scrollRef.current?.blur()
      return
    }
    if (jumpActive) {
      textareaRef.current?.blur()
      commandRef.current?.blur()
      scrollRef.current?.blur()
      return
    }
    if (interaction.overlay) {
      textareaRef.current?.blur()
      commandRef.current?.blur()
      if (interaction.overlay === "sessions") sessionSearchRef.current?.focus()
      else if (interaction.overlay === "questions") {
        if (questionInputRef.current) questionInputRef.current.focus()
        else scrollRef.current?.focus()
      }
      else scrollRef.current?.focus()
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
  }, [interactive, interaction.mode, interaction.overlay, interaction.surface, jumpActive])
  useEffect(() => {
    if (!interactive || jumpActive || interaction.surface !== "transcript" || interaction.overlay || (interaction.mode !== "normal" && interaction.mode !== "visual")) return
    const updateCursor = () => {
      const target = transcript.selection?.head ?? transcript.cursor
      const scrollbox = scrollRef.current
      let activeLayout = measuredLayout.current ?? layout
      const viewport = scrollbox?.viewport
      // The native viewport may move after the hook's frame listener. Refresh
      // the O(1) cached translation before deciding cursor visibility; clean
      // blocks are neither scanned nor remeasured on this path.
      if (target && scrollbox && transcriptRuntime) {
        const refreshed = measureRenderedTranscript(renderer, scrollbox, {
          frame: transcriptRuntime.getSnapshot(), runtime: transcriptRuntime, styleRevision: transcriptStyleRevision,
        })
        if (refreshed) {
          measuredLayout.current = refreshed
          activeLayout = refreshed
        }
      }
      const point = measuredPoint(activeLayout, target)
      const visible = Boolean(point && viewport && point.screenX >= viewport.screenX && point.screenX < viewport.screenX + viewport.width
        && point.screenY >= viewport.screenY && point.screenY < viewport.screenY + viewport.height)
      if (!point || !visible) { renderer.setCursorPosition(0, 0, false); return }
      renderer.setCursorStyle({ style: "block", blinking: false })
      // OpenTUI's hardware cursor coordinates are one-based; measured cells are zero-based.
      renderer.setCursorPosition(point.screenX + 1, point.screenY + 1, true)
    }
    updateCursor()
    renderer.on(CliRenderEvents.FRAME, updateCursor)
    return () => {
      renderer.off(CliRenderEvents.FRAME, updateCursor)
      renderer.setCursorPosition(0, 0, false)
    }
  }, [interactive, jumpActive, interaction.mode, interaction.overlay, interaction.surface, layout, renderer, transcript.cursor, transcript.selection, transcriptRuntime, transcriptStyleRevision])
  useEffect(() => {
    if (!interactive) return
    const updateSelection = () => {
      const runtimeFrame = transcriptRuntime?.getSnapshot()
      const selectionTranscript = runtimeFrame?.transcript ?? transcript
      const clear = () => {
        if (renderer.getSelection()) renderer.clearSelection()
        appliedNativeSelection.current = undefined
      }
      if (jumpActive || interaction.surface !== "transcript" || !selectionTranscript.selection) {
        clear()
        return
      }
      const scrollbox = scrollRef.current
      if (!scrollbox) { clear(); return }
      const token = runtimeFrame ?? layout
      const applied = appliedNativeSelection.current
      if (applied && applied.token === token && applied.selection === selectionTranscript.selection
        && applied.scrollTop === scrollbox.scrollTop
        && !applied.startRoot.isDestroyed && !applied.endRoot.isDestroyed
        && !applied.startTarget.isDestroyed && !applied.endTarget.isDestroyed
        && applied.startRoot.screenX === applied.startX && applied.startRoot.screenY === applied.startY
        && applied.endRoot.screenX === applied.endX && applied.endRoot.screenY === applied.endY
        && renderer.getSelection()) return

      let activeLayout = layout
      if (runtimeFrame && transcriptRuntime) {
        const refreshed = measureRenderedTranscript(renderer, scrollbox, {
          frame: runtimeFrame, runtime: transcriptRuntime, styleRevision: transcriptStyleRevision,
        })
        if (!refreshed || refreshed.materializedBlocks !== runtimeFrame.window.blocks) { clear(); return }
        measuredLayout.current = refreshed
        activeLayout = refreshed
      } else activeLayout = measuredLayout.current ?? layout
      const clipped = materializedSelectionEndpoints(selectionTranscript, activeLayout, undefined, scrollbox.viewport)
      if (!clipped) {
        clear()
        return
      }
      const forward = clipped.anchor.screenY < clipped.head.screenY
        || (clipped.anchor.screenY === clipped.head.screenY && clipped.anchor.screenX <= clipped.head.screenX)
      const start = forward ? clipped.anchor : clipped.head
      const end = forward ? clipped.head : clipped.anchor
      const startItem = scrollbox.getRenderable(transcriptRenderableIdForPoint(activeLayout, start))
      const endItem = scrollbox.getRenderable(transcriptRenderableIdForPoint(activeLayout, end))
      const startTarget = startItem ? selectableAt(startItem, start.screenX, start.screenY) : undefined
      const endTarget = endItem ? selectableAt(endItem, end.screenX, end.screenY) : undefined
      if (!startTarget || !endTarget) {
        clear()
        return
      }
      renderer.startSelection(startTarget, start.screenX, start.screenY, selectionTranscript.selection.shape === "line" ? "line" : "cell")
      renderer.updateSelection(endTarget, end.screenX, end.screenY, { finishDragging: true })
      appliedNativeSelection.current = {
        token, selection: selectionTranscript.selection, scrollTop: scrollbox.scrollTop,
        startRoot: startItem!, endRoot: endItem!, startTarget, endTarget,
        startX: startItem!.screenX, startY: startItem!.screenY,
        endX: endItem!.screenX, endY: endItem!.screenY,
      }
    }
    updateSelection()
    renderer.on(CliRenderEvents.FRAME, updateSelection)
    return () => { renderer.off(CliRenderEvents.FRAME, updateSelection) }
  }, [interactive, jumpActive, interaction.surface, layout, renderer, transcript.cursor, transcript.selection, transcriptRuntime, transcriptStyleRevision])
  useEffect(() => {
    if (!interactive || interaction.surface !== "transcript" || transcript.viewport.kind === "tail" || !transcript.cursor) return
    const scrollbox = scrollRef.current
    if (!scrollbox) return
    const point = measuredPoint(measuredLayout.current ?? layout, transcript.cursor)
    if (!point) {
      if (!transcriptRuntime) scrollbox.scrollChildIntoView(transcriptRenderableIdForPoint(layout, transcript.cursor))
      return
    }
    const top = scrollbox.viewport.screenY
    const bottom = top + scrollbox.viewport.height - 1
    // Reveal the logical cell rather than a potentially thousand-row item.
    if (point.screenY < top) {
      scrollbox.scrollBy(point.screenY - top, "step")
    } else if (point.screenY > bottom) {
      scrollbox.scrollBy(point.screenY - bottom, "step")
    }
  }, [transcript.cursor?.itemId, transcript.cursor?.graphemeOffset, transcriptRuntime])

  const dispatchMotion = useCallback((motion: Motion, repeat = 1) => {
    const activeLayout = measuredLayout.current ?? layout
    const crossesWindow = motion === "left" || motion === "right" || motion === "up" || motion === "down"
    const calculate = (candidateLayout: TranscriptLayout) => {
      let point = transcript.cursor
      let result: ReturnType<typeof movePoint>
      for (let index = 0; index < repeat; index += 1) {
        result = movePoint(candidateLayout, point, motion)
        if (!result) return undefined
        if (point?.itemId === result.point.itemId && point.graphemeOffset === result.point.graphemeOffset
          && (crossesWindow || index < repeat - 1)) return undefined
        point = result.point
      }
      return result
    }
    let result = motion === "first" || motion === "last" ? undefined : calculate(activeLayout)
    // A mounted layout deliberately ends at the window boundary. Resolve only
    // the logical items visited by the off-window motion; the full estimated
    // layout remains a test oracle rather than production work.
    if (!result && (motion === "first" || motion === "last" || crossesWindow)) {
      result = movePointInTranscript(transcript, Math.max(8, dimensions.width - 7), transcript.cursor, motion, repeat)
    }
    if (result) controller.transcript({
      type: motion === "first" || motion === "last" ? "jump" : "cursor.move",
      target: result.point,
      preferredScreenRow: (() => {
        const measured = measuredPoint(activeLayout, result.point)
        const viewport = scrollRef.current?.viewport
        if (measured && viewport) return Math.max(0, Math.min(viewport.height - 1, measured.screenY - viewport.screenY))
        if (motion === "first") return 0
        if (motion === "last" && viewport) return Math.max(0, viewport.height - 1)
        const origin = measuredPoint(activeLayout, transcript.cursor)
        return origin && viewport ? Math.max(0, Math.min(viewport.height - 1, origin.screenY - viewport.screenY)) : 0
      })(),
      extend: interaction.mode === "visual",
    })
  }, [controller, dimensions.width, interaction.mode, layout, transcript])
  const countedMotion = useCallback((motion: Motion) => {
    dispatchMotion(motion, countRef.current ? Math.max(1, Number.parseInt(countRef.current, 10)) : 1)
    countRef.current = ""
    controller.dispatchInteraction({ type: "count.clear" })
  }, [controller, dispatchMotion])

  const applyComposerAction = useCallback((action: ComposerVimAction) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const nativeSelection = textarea.getSelection()
    const result = applyComposerVimAction({
      text: textarea.plainText,
      cursorOffset: codeUnitOffsetToGraphemeOffset(textarea.plainText, textarea.cursorOffset),
      selection: composerSelectionRef.current ?? (nativeSelection ? {
        anchor: codeUnitOffsetToGraphemeOffset(textarea.plainText, nativeSelection.start),
        head: Math.max(0, codeUnitOffsetToGraphemeOffset(textarea.plainText, nativeSelection.end) - 1),
      } : undefined),
    }, action, composerInteractionRef.current.unnamedRegister)
    if (result.effect?.type === "history") {
      if (result.effect.direction === "undo") textarea.undo()
      else textarea.redo()
    } else {
      if (textarea.plainText !== result.buffer.text) textarea.replaceText(result.buffer.text)
      textarea.cursorOffset = graphemeOffsetToCodeUnitOffset(result.buffer.text, result.buffer.cursorOffset)
      if (result.buffer.selection) textarea.setSelectionInclusive(
        graphemeOffsetToCodeUnitOffset(result.buffer.text, result.buffer.selection.anchor),
        graphemeOffsetToCodeUnitOffset(result.buffer.text, result.buffer.selection.head),
      )
      else textarea.clearSelection()
    }
    composerSelectionRef.current = result.buffer.selection
    controller.changeDraft(textarea.plainText, codeUnitOffsetToGraphemeOffset(textarea.plainText, textarea.cursorOffset))
    const previous = composerInteractionRef.current.unnamedRegister
    if (previous.text !== result.register.text || previous.shape !== result.register.shape) {
      controller.dispatchInteraction({ type: "register.set", register: result.register })
    }
    if (result.effect?.type === "copy") controller.copyText(result.effect.text)
    if (result.effect?.type === "submit") {
      controller.submit(busy && settings.busySubmit === "steer" ? "steer" : "next-turn")
      // Normal-mode Enter bypasses the textarea's native submit callback. Clear
      // it immediately so bytes already waiting in the terminal start a new
      // draft instead of appending to the submitted buffer.
      textarea.setText("")
      textarea.cursorOffset = 0
      textarea.clearSelection()
      composerSelectionRef.current = undefined
      controller.changeDraft("", 0)
    }
    if (result.effect?.type === "retry") {
      const failed = composer.outbox.find((message) => message.status === "failed")
      if (failed) controller.retryOutgoing(failed.id)
    }
  }, [busy, composer.outbox, controller, settings.busySubmit])
  const runComposerKey = useCallback((key: string) => {
    if (key === "a" && composerInteractionRef.current.mode === "normal" && composerInteractionRef.current.pendingKeys === "g") {
      composerInteractionRef.current = { ...composerInteractionRef.current, pendingKeys: "" }
      controller.dispatchInteraction({ type: "keys.pending", value: "" })
      controller.dispatchInteraction({ type: "overlay.open", overlay: "agents" })
      return
    }
    const resolution = resolveComposerKey(composerInteractionRef.current, key)
    composerInteractionRef.current = resolution.state
    if (resolution.action) applyComposerAction(resolution.action)
    for (const command of resolution.commands) controller.dispatchInteraction(command)
  }, [applyComposerAction, controller])

  const scroll = useCallback((direction: "up" | "down", amount: "line" | "half-page" | "page") => {
    const delta = direction === "down" ? 1 : -1
    const explicitCount = countRef.current ? Math.max(1, Number.parseInt(countRef.current, 10)) : undefined
    const effectiveAmount = explicitCount && amount === "half-page" ? "line" : amount
    const repeat = explicitCount ?? 1
    scrollRef.current?.scrollBy(delta * repeat * (effectiveAmount === "line" ? 1 : effectiveAmount === "half-page" ? 0.5 : 1), effectiveAmount === "line" ? "step" : "viewport")
    onManualScroll()
    countRef.current = ""
    if (explicitCount !== undefined) controller.dispatchInteraction({ type: "count.clear" })
  }, [controller, onManualScroll])

  const beginVisual = useCallback((shape: "character" | "line") => {
    if (!transcript.cursor) dispatchMotion("last")
    controller.transcript({ type: "selection.begin", shape })
    controller.dispatchInteraction({ type: "mode.visual" })
  }, [controller, dispatchMotion, transcript.cursor])

  const closeOverlay = useCallback(() => controller.dispatchInteraction({ type: "overlay.close" }), [controller])
  const openOverlay = useCallback((overlay: "sessions" | "approvals" | "questions" | "fork" | "agents" | "urls" | "help") => {
    controller.dispatchInteraction({ type: "overlay.open", overlay })
  }, [controller])

  const activateOverlay = useCallback(() => {
    const activeIndex = overlayIndexRef.current
    if (interaction.overlay === "models") {
      if (modelPicker.stage === "models") {
        const model = state.availableModels?.[activeIndex]
        if (!model) return
        if (model.efforts.length) {
          flushSync(() => {
            setModelPicker({ stage: "efforts", modelId: model.id })
            const effortIndex = Math.max(0, model.efforts.indexOf(summary?.reasoningEffort ?? ""))
            overlayIndexRef.current = effortIndex
            setOverlayIndex(effortIndex)
          })
          return
        }
        controller.executeCommand(`model ${model.id}`, presentationId)
      } else {
        const model = state.availableModels?.find(candidate => candidate.id === modelPicker.modelId)
        const effort = model?.efforts[activeIndex]
        if (!model || !effort) return
        controller.executeCommand(`model ${model.id} ${effort}`, presentationId)
      }
    } else if (interaction.overlay === "sessions") {
      // Input events and Return can arrive in one terminal read. Read the native
      // value so Return never activates rows from the previous React render.
      const liveQuery = liveSessionQuery.current || sessionSearchRef.current?.value || sessionQuery
      const liveRows = liveQuery === sessionQuery ? sessionRows : searchSessions(state.threadOrder, state.summaries, liveQuery, state.favoriteThreadIds, sessionCwd)
      const liveIndex = liveQuery === sessionQuery ? activeIndex : 0
      const id = liveRows[Math.min(liveIndex, Math.max(0, liveRows.length - 1))]?.id
      if (id) controller.openThread(id)
    } else if (interaction.overlay === "approvals" && pendingApproval) {
      const choice = pendingApproval.choices[Math.min(activeIndex, Math.max(0, pendingApproval.choices.length - 1))]
      if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
    } else if (interaction.overlay === "questions" && pendingQuestion) {
      const question = pendingQuestion.questions[Math.min(questionIndex, pendingQuestion.questions.length - 1)]
      if (!question) return
      const liveValue = questionInputRef.current?.value
      const typed = liveValue?.length ? liveValue : questionAnswers[question.id]
      const option = question.options?.[Math.min(activeIndex, Math.max(0, (question.options?.length ?? 1) - 1))]
      const answer = typeof typed === "string" && typed.length ? typed : option?.label
      if (!answer) return
      const answers = { ...questionAnswers, [question.id]: answer }
      setQuestionAnswers(answers)
      if (questionIndex < pendingQuestion.questions.length - 1) { overlayIndexRef.current = 0; setQuestionIndex((value) => value + 1); setOverlayIndex(0); return }
      controller.answerQuestions(pendingQuestion.id, answers)
    } else if (interaction.overlay === "fork" && state.pendingFork) {
      controller.confirmFork()
    } else if (interaction.overlay === "agents") {
      const row = agentRows[Math.min(activeIndex, Math.max(0, agentRows.length - 1))]
      if (row?.direction === "parent") controller.returnToParent()
      if (row?.direction === "child") controller.openChildThread(row.threadId)
    } else if (interaction.overlay === "urls") {
      const choice = state.urlChoices?.[Math.min(activeIndex, Math.max(0, (state.urlChoices?.length ?? 1) - 1))]
      if (choice) controller.transcript({ type: "url.open", url: choice.url, presentationId })
    }
    closeOverlay()
  }, [agentRows, closeOverlay, controller, interaction.overlay, modelPicker, overlayIndex, pendingApproval, pendingQuestion, presentationId, questionAnswers, questionIndex, sessionQuery, sessionRows, state.availableModels, state.favoriteThreadIds, state.pendingFork, state.summaries, state.threadOrder, state.urlChoices, summary?.reasoningEffort, sessionCwd])

  const bindingContext: VimBindingContext = {
    interaction, transcript, composer, controller, presentationId, countRef, textareaRef, scrollRef,
    toggleComposer: () => { setComposerExpanded(value => !value); controller.dispatchInteraction({ type: "focus.set", surface: "composer" }) },
    distinctControlI,
    submitComposer: intent => composerSubmitRef.current?.(intent),
    countedMotion, dispatchMotion, runComposerKey, beginVisual, openOverlay, scroll, enterVisibleTranscript,
  }
  const changeCommandLine = useCallback((value: string) => {
    commandRef.current?.setText(commandBody(value))
    controller.dispatchInteraction({ type: "command.change", value })
  }, [controller])
  const recallCommandLine = useCallback((direction: -1 | 1) => {
    const recalled = recallCommand(commandHistoryRef.current, interaction.commandLine, direction)
    commandHistoryRef.current = recalled.history
    changeCommandLine(recalled.value)
  }, [changeCommandLine, interaction.commandLine])
  const completeCommandLine = useCallback(() => {
    if (commandPrompt(interaction.commandLine) !== ":") return
    const match = commandCompletions(interaction.commandLine)[0]
    if (match) changeCommandLine(match)
  }, [changeCommandLine, interaction.commandLine])
  useBindings(() => ({
    priority: 100,
    bindings: !interactive || interaction.overlay || jumpActive ? [] : [
      { key: "ctrl+g", cmd: () => setJumpOpen(true) },
      ...((interaction.mode === "normal" || (interaction.surface === "transcript" && interaction.mode === "visual")) ? [{ key: "s", cmd: () => setJumpOpen(true) }] : []),
      ...commonBindings(bindingContext),
      ...(interaction.mode === "normal" ? normalBindings(bindingContext) : []),
      ...(interaction.mode === "visual" ? visualBindings(bindingContext) : []),
      ...(interaction.mode === "insert" ? insertBindings(bindingContext) : []),
      ...(interaction.mode === "command" ? commandBindings(bindingContext) : []),
    ].map((binding) => ({ ...binding, cmd: () => flushSync(() => binding.cmd()) })),
  }), [interactive, bindingContext, settings.keybindings, jumpActive])
  useBindings(() => ({
    priority: 150,
    bindings: !interactive || interaction.overlay || jumpActive ? [] : Object.entries(settings.keybindings)
      .map(([key, command]) => ({ key, cmd: () => controller.executeNamedCommand(command, presentationId) })),
  }), [interactive, controller, interaction.overlay, jumpActive, presentationId, settings.keybindings])
  useBindings(() => ({
    priority: 175,
    bindings: !interactive || jumpActive || interaction.overlay || interaction.mode !== "command" ? [] : [
      { key: "up", cmd: () => recallCommandLine(-1) },
      { key: "ctrl+p", cmd: () => recallCommandLine(-1) },
      { key: "down", cmd: () => recallCommandLine(1) },
      { key: "ctrl+n", cmd: () => recallCommandLine(1) },
      { key: "tab", cmd: completeCommandLine },
    ],
  }), [interactive, completeCommandLine, interaction.mode, interaction.overlay, jumpActive, recallCommandLine])

  useBindings(() => ({
    priority: 200,
    bindings: !interactive || !interaction.overlay ? [] : [
      { key: "escape", cmd: () => {
        if (interaction.overlay === "models" && modelPicker.stage === "efforts") {
          const index = state.availableModels?.findIndex(model => model.id === modelPicker.modelId) ?? 0
          flushSync(() => {
            setModelPicker({ stage: "models" })
            overlayIndexRef.current = Math.max(0, index)
            setOverlayIndex(overlayIndexRef.current)
          })
          return
        }
        if (interaction.overlay === "fork") controller.cancelFork()
        closeOverlay()
      } },
      ...(interaction.overlay === "sessions" ? [] : [{ key: "?", cmd: closeOverlay }]),
      ...(["down", "ctrl+n", ...(interaction.overlay === "sessions" || (interaction.overlay === "questions" && questionOwnsReturn) ? [] : ["j"])]
        .map((key) => ({ key, cmd: () => {
          overlayIndexRef.current = Math.min(Math.max(0, overlayLength - 1), overlayIndexRef.current + 1)
          flushSync(() => setOverlayIndex(overlayIndexRef.current))
        } }))),
      ...(["up", "ctrl+p", ...(interaction.overlay === "sessions" || (interaction.overlay === "questions" && questionOwnsReturn) ? [] : ["k"])]
        .map((key) => ({ key, cmd: () => {
          overlayIndexRef.current = Math.max(0, overlayIndexRef.current - 1)
          flushSync(() => setOverlayIndex(overlayIndexRef.current))
        } }))),
      ...((interaction.overlay === "sessions" || (interaction.overlay === "questions" && questionOwnsReturn)) ? [] : [{ key: "return", cmd: activateOverlay }]),
      ...(interaction.overlay === "approvals" ? Array.from({ length: 9 }, (_, index) => ({ key: `${index + 1}`, cmd: () => {
        if (!pendingApproval) return
        const choice = pendingApproval.choices[index]
        if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
      } })) : []),
    ],
  }), [interactive, activateOverlay, interaction.overlay, closeOverlay, controller, modelPicker, overlayLength, pendingApproval, questionOwnsReturn, state.availableModels])

  return (
    <FullscreenShell paneLabel={paneLabel} title={summary?.title} parentTitle={parentTitle} connection={state.connection} working={activity.working} activityLabel={activityLabel} activityStartedAt={activity.startedAt} waiting={Boolean(pendingApproval || pendingQuestion)} presentationVisible={presentationVisible}
      notice={interactive ? <NoticeStrip message={state.error} /> : undefined}
      transcript={<TranscriptViewport window={transcriptWindow} state={transcript} surface={interaction.surface} syntax={syntax} scrollRef={scrollRef} onManualScroll={onManualScroll} />}
      commandLine={interactive && !jumpActive && interaction.mode === "command" ? <CommandLine currentTitle={summary?.title} sessionIds={state.threadOrder} currentModel={summary?.model} models={state.availableModels} value={interaction.commandLine} inputRef={commandRef} controller={controller} onSubmit={(line) => {
        commandHistoryRef.current = recordCommand(commandHistoryRef.current, line)
        controller.executeCommand(line, presentationId)
      }} /> : undefined}
      composer={<Composer
        interactive={interactive}
        expanded={composerExpanded}
        key={state.activeThreadId}
        state={composer}
        mode={interaction.mode}
        activeTurn={busy}
        model={summary?.model}
        reasoningEffort={summary?.reasoningEffort}
        maxHeight={composerExpanded ? Math.max(1, dimensions.height - (parentTitle ? 10 : 9)) : Math.max(3, Math.floor(dimensions.height * Math.max(0.1, Math.min(0.6, settings.composerMaxHeight))))}
        insertEnter={settings.insertEnter}
        busySubmit={settings.busySubmit}
        textareaRef={textareaRef}
        submitRef={composerSubmitRef}
        onChange={slashCommands.changeDraft}
        drawer={slashCommands.active ? <SlashCommandDrawer choices={slashCommands.choices} selected={slashCommands.selected} hint={slashCommands.feedback} /> : undefined}
        onSubmit={slashCommands.submit}
        onEscape={() => {
          if (composerInteractionRef.current.mode === "visual") runComposerKey("escape")
          else if (composerInteractionRef.current.mode === "insert") controller.dispatchInteraction({ type: "mode.normal" })
        }}
        onRetry={controller.retryOutgoing}
      />}
      statusline={<Statusline
        mode={interaction.mode}
        summary={summary}
        pendingKeys={interaction.pendingKeys}
        unseenEntries={semanticTranscript.unseenEntries}
        pendingApprovals={state.approvals.order.length}
        pendingQuestions={Object.keys(state.questions).length}
        activeTurn={busy}
        selectionCount={selectionCount}
      />}
      overlay={interactive ? <>{jumpActive ? <FlashJump fromComposer={interaction.surface === "composer"} transcript={transcript} frame={transcriptFrame} runtime={transcriptRuntime} styleRevision={transcriptStyleRevision} layout={layout} scrollRef={scrollRef} controller={controller} extend={interaction.mode === "visual" && interaction.surface === "transcript"} onClose={() => setJumpOpen(false)} /> : null}<OverlayLayer
        models={state.availableModels}
        modelCatalogError={state.modelCatalogError}
        modelPicker={modelPicker}
        overlay={interaction.overlay}
        sessions={sessionRows}
        sessionScope={allSessions ? "All sessions" : "This directory"}
        onSessionToggleScope={() => flushSync(() => {
          setAllSessions(value => !value)
          overlayIndexRef.current = 0
          setOverlayIndex(0)
        })}
        onSessionRename={(id, title) => controller.renameThread(id, title)}
        onSessionFavorite={(id) => {
          const favorites = state.favoriteThreadIds.includes(id) ? state.favoriteThreadIds.filter(value => value !== id) : [...state.favoriteThreadIds, id]
          const rows = searchSessions(state.threadOrder, state.summaries, sessionQuery, favorites, sessionCwd)
          const index = Math.max(0, rows.findIndex(row => row.id === id))
          overlayIndexRef.current = index
          flushSync(() => { controller.toggleFavorite(id); setOverlayIndex(index) })
        }}
        sessionSearchEditing={interaction.mode === "insert"}
        onSessionSearchEditing={(editing) => flushSync(() => controller.dispatchInteraction({ type: editing ? "mode.insert" : "mode.normal" }))}
        onSessionMove={(delta) => {
          overlayIndexRef.current = Math.max(0, Math.min(sessionRows.length - 1, overlayIndexRef.current + delta))
          flushSync(() => setOverlayIndex(overlayIndexRef.current))
        }}
        sessionQuery={sessionQuery}
        sessionSearchRef={sessionSearchRef}
        onSessionQuery={(value) => {
          liveSessionQuery.current = value
          overlayIndexRef.current = 0
          flushSync(() => { setSessionQuery(value); setOverlayIndex(0) })
        }}
        summaries={state.summaries}
        activeThreadId={state.activeThreadId}
        approval={pendingApproval}
        question={pendingQuestion}
        questionIndex={questionIndex}
        answers={questionAnswers}
        questionInputRef={questionInputRef}
        onQuestionInput={(value) => {
          const question = pendingQuestion?.questions[questionIndex]
          if (question) setQuestionAnswers((answers) => ({ ...answers, [question.id]: value }))
        }}
        onActivate={activateOverlay}
        pendingFork={state.pendingFork}
        agents={agentRows}
        urls={state.urlChoices ?? []}
        selected={overlayIndex}
      /></> : undefined}
    />
  )
}

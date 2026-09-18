import { CliRenderEvents, type InputRenderable, type Renderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { initialComposer } from "@vimex/composer"
import { applyComposerVimAction, codeUnitOffsetToGraphemeOffset, commandCompletions, graphemeOffsetToCodeUnitOffset, initialCommandHistory, initialInteraction, recallCommand, recordCommand, resolveComposerKey, type ComposerVimAction, type InteractionState } from "@vimex/interaction"
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
import { commandBody, commandPrompt, CommandLine } from "../composer/CommandLine"
import { searchSessions } from "../sessions/session-search"
import { agentNavigationRows } from "../agents/AgentsOverlay"

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
  const settings = { ...defaultVimexUiSettings, ...settingsInput, ...state.preferences }
  selectTheme(settings.theme, settings.reducedColor)
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
  const syntax = useMemo(() => createEmberTideSyntax(settings.syntaxTheme === "theme" ? settings.theme : settings.syntaxTheme, settings.reducedColor), [settings.reducedColor, settings.syntaxTheme, settings.theme])
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const textareaRef = useRef<TextareaRenderable>(null)
  const commandRef = useRef<InputRenderable>(null)
  const sessionSearchRef = useRef<InputRenderable>(null)
  const questionInputRef = useRef<InputRenderable>(null)
  const commandHistoryRef = useRef(initialCommandHistory())
  const composerSelectionRef = useRef<{ anchor: number; head: number } | undefined>(undefined)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [sessionQuery, setSessionQuery] = useState("")
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | readonly string[]>>({})
  const [renderedLayout, setRenderedLayout] = useState<TranscriptLayout>()
  const measuredLayout = useRef<TranscriptLayout | undefined>(undefined)
  const layoutSignature = useRef("")
  const pendingScrollAnchor = useRef(false)
  const pendingRestore = useRef(false)
  const countRef = useRef(interaction.count)
  const composerInteractionRef = useRef(interaction)
  const composerThreadRef = useRef(state.activeThreadId)
  composerInteractionRef.current = interaction
  const initializedFolds = useRef(new Set<string>())
  const transcriptWidth = Math.max(8, dimensions.width - 7)
  const estimatedLayout = useMemo(() => buildTranscriptLayout(transcript, transcriptWidth), [transcript, transcriptWidth])
  const layout = renderedLayout ?? estimatedLayout
  const busy = activeTurn(interaction, workspace?.conversation.activeTurnId)
  const pendingApproval = state.approvals.order
    .map((id) => state.approvals.byId[id])
    .find((approval) => approval !== undefined && approval.threadId === state.activeThreadId && (approval.status === "pending" || approval.status === "failed"))
  const pendingQuestion = Object.values(state.questions).find((question) => question.threadId === state.activeThreadId)
  const sessionRows = useMemo(() => searchSessions(state.threadOrder, state.summaries, sessionQuery), [sessionQuery, state.summaries, state.threadOrder])
  const agentRows = useMemo(() => agentNavigationRows(state.activeThreadId, state.agentRelationships), [state.activeThreadId, state.agentRelationships])
  const selectionCount = selectedText(transcript, "plain")
  const overlayLength = interaction.overlay === "sessions" ? sessionRows.length
    : interaction.overlay === "approvals" ? (pendingApproval?.choices.length ?? 0)
      : interaction.overlay === "questions" ? (pendingQuestion?.questions[questionIndex]?.options?.length ?? 1)
        : interaction.overlay === "agents" ? agentRows.length
          : interaction.overlay === "urls" ? (state.urlChoices?.length ?? 0)
            : 1

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
    for (const item of items) {
      const foldKey = `${state.activeThreadId ?? ""}:${item.id}`
      if (initializedFolds.current.has(foldKey) || Object.hasOwn(transcript.folded, item.id)) continue
      initializedFolds.current.add(foldKey)
      if ((settings.foldReasoning && item.kind === "reasoning") || (settings.foldTools && (item.kind === "tool" || item.kind === "command" || item.kind === "edit"))) {
        controller.transcript({ type: "fold.set", itemId: item.id, folded: true })
      }
    }
  }, [controller, items, settings.foldReasoning, settings.foldTools, state.activeThreadId, transcript.folded])
  useEffect(() => {
    const measure = () => {
      const scrollbox = scrollRef.current
      if (!scrollbox) return
      const next = measureRenderedTranscript(renderer, scrollbox, transcript)
      if (!next) return
      if (next !== measuredLayout.current) {
        measuredLayout.current = next
        const signature = JSON.stringify(next.points)
        if (signature !== layoutSignature.current) {
          layoutSignature.current = signature
          setRenderedLayout(next)
        }
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
  const geometryRevision = `${dimensions.width}:${dimensions.height}:${Object.entries(transcript.folded).map(([id, folded]) => `${id}:${folded}`).join(",")}:${transcript.order.map((id) => transcript.projectionById[id]?.revision ?? 0).join(",")}`
  useEffect(() => {
    if (transcript.viewport.kind === "point") pendingRestore.current = true
  }, [geometryRevision])
  useEffect(() => {
    setOverlayIndex(0)
    if (interaction.overlay !== "sessions") setSessionQuery("")
  }, [interaction.overlay])
  useEffect(() => { setQuestionIndex(0); setQuestionAnswers({}) }, [pendingQuestion?.id])
  useEffect(() => {
    if (state.pendingFork && interaction.overlay !== "fork") controller.dispatchInteraction({ type: "overlay.open", overlay: "fork" })
    else if (!state.pendingFork && pendingQuestion && !interaction.overlay) controller.dispatchInteraction({ type: "overlay.open", overlay: "questions" })
  }, [controller, interaction.overlay, pendingQuestion, state.pendingFork])
  useEffect(() => {
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
    if (result.effect?.type === "submit") controller.submit(busy && settings.busySubmit === "steer" ? "steer" : "next-turn")
    if (result.effect?.type === "retry") {
      const failed = composer.outbox.find((message) => message.status === "failed")
      if (failed) controller.retryOutgoing(failed.id)
    }
  }, [busy, composer.outbox, controller, settings.busySubmit])
  const runComposerKey = useCallback((key: string) => {
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
    pendingScrollAnchor.current = true
    for (let index = 0; index < repeat; index += 1) controller.transcript({ type: "viewport.scroll", direction, amount: effectiveAmount })
    countRef.current = ""
    controller.dispatchInteraction({ type: "count.clear" })
  }, [controller])

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
    if (interaction.overlay === "sessions") {
      const id = sessionRows[Math.min(overlayIndex, Math.max(0, sessionRows.length - 1))]?.id
      if (id) controller.openThread(id)
    } else if (interaction.overlay === "approvals" && pendingApproval) {
      const choice = pendingApproval.choices[Math.min(overlayIndex, Math.max(0, pendingApproval.choices.length - 1))]
      if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
    } else if (interaction.overlay === "questions" && pendingQuestion) {
      const question = pendingQuestion.questions[Math.min(questionIndex, pendingQuestion.questions.length - 1)]
      if (!question) return
      const liveValue = questionInputRef.current?.value
      const typed = liveValue?.length ? liveValue : questionAnswers[question.id]
      const option = question.options?.[Math.min(overlayIndex, Math.max(0, (question.options?.length ?? 1) - 1))]
      const answer = typeof typed === "string" && typed.length ? typed : option?.label
      if (!answer) return
      const answers = { ...questionAnswers, [question.id]: answer }
      setQuestionAnswers(answers)
      if (questionIndex < pendingQuestion.questions.length - 1) { setQuestionIndex((value) => value + 1); setOverlayIndex(0); return }
      controller.answerQuestions(pendingQuestion.id, answers)
    } else if (interaction.overlay === "fork" && state.pendingFork) {
      controller.confirmFork()
    } else if (interaction.overlay === "agents") {
      const row = agentRows[Math.min(overlayIndex, Math.max(0, agentRows.length - 1))]
      if (row?.direction === "parent") controller.returnToParent()
      if (row?.direction === "child") controller.openChildThread(row.threadId)
    } else if (interaction.overlay === "urls") {
      const choice = state.urlChoices?.[Math.min(overlayIndex, Math.max(0, (state.urlChoices?.length ?? 1) - 1))]
      if (choice) controller.transcript({ type: "url.open", url: choice.url })
    }
    closeOverlay()
  }, [agentRows, closeOverlay, controller, interaction.overlay, overlayIndex, pendingApproval, pendingQuestion, questionAnswers, questionIndex, sessionRows, state.pendingFork, state.urlChoices])

  const bindingContext: VimBindingContext = {
    interaction, transcript, composer, controller, countRef, textareaRef, scrollRef,
    countedMotion, dispatchMotion, runComposerKey, beginVisual, openOverlay, scroll,
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
    bindings: interaction.overlay ? [] : [
      ...commonBindings(bindingContext),
      ...(interaction.mode === "normal" ? normalBindings(bindingContext) : []),
      ...(interaction.mode === "visual" ? visualBindings(bindingContext) : []),
      ...(interaction.mode === "insert" ? insertBindings(bindingContext) : []),
      ...(interaction.mode === "command" ? commandBindings(bindingContext) : []),
    ],
  }), [bindingContext, settings.keybindings])
  useBindings(() => ({
    priority: 150,
    bindings: interaction.overlay ? [] : Object.entries(settings.keybindings)
      .map(([key, command]) => ({ key, cmd: () => controller.executeNamedCommand(command) })),
  }), [controller, interaction.overlay, settings.keybindings])
  useBindings(() => ({
    priority: 175,
    bindings: interaction.overlay || interaction.mode !== "command" ? [] : [
      { key: "up", cmd: () => recallCommandLine(-1) },
      { key: "down", cmd: () => recallCommandLine(1) },
      { key: "tab", cmd: completeCommandLine },
    ],
  }), [completeCommandLine, interaction.mode, interaction.overlay, recallCommandLine])

  useBindings(() => ({
    priority: 200,
    bindings: !interaction.overlay ? [] : [
      { key: "escape", cmd: () => {
        if (interaction.overlay === "fork") controller.cancelFork()
        closeOverlay()
      } },
      { key: "?", cmd: closeOverlay },
      ...(["down", "ctrl+n", ...(interaction.overlay === "sessions" || interaction.overlay === "questions" ? [] : ["j"])]
        .map((key) => ({ key, cmd: () => setOverlayIndex((value) => Math.min(Math.max(0, overlayLength - 1), value + 1)) }))),
      ...(["up", "ctrl+p", ...(interaction.overlay === "sessions" || interaction.overlay === "questions" ? [] : ["k"])]
        .map((key) => ({ key, cmd: () => setOverlayIndex((value) => Math.max(0, value - 1)) }))),
      { key: "return", cmd: activateOverlay },
      ...(interaction.overlay === "approvals" ? Array.from({ length: 9 }, (_, index) => ({ key: `${index + 1}`, cmd: () => {
        if (!pendingApproval) return
        const choice = pendingApproval.choices[index]
        if (choice) controller.resolveApproval(pendingApproval.id, choice.id)
      } })) : []),
    ],
  }), [activateOverlay, interaction.overlay, closeOverlay, controller, overlayLength, pendingApproval])

  return (
    <FullscreenShell title={summary?.title} connection={state.connection} working={summary?.status === "working"}
      transcript={<TranscriptViewport items={items} state={transcript} interaction={interaction} syntax={syntax} scrollRef={scrollRef} />}
      commandLine={interaction.mode === "command" ? <CommandLine value={interaction.commandLine} inputRef={commandRef} controller={controller} onSubmit={(line) => {
        commandHistoryRef.current = recordCommand(commandHistoryRef.current, line)
        controller.executeCommand(line)
      }} /> : undefined}
      composer={<Composer
        key={state.activeThreadId}
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
        pendingQuestions={Object.keys(state.questions).length}
        activeTurn={busy}
      />}
      overlay={<OverlayLayer
        overlay={interaction.overlay}
        sessions={sessionRows}
        sessionQuery={sessionQuery}
        sessionSearchRef={sessionSearchRef}
        onSessionQuery={(value) => { setSessionQuery(value); setOverlayIndex(0) }}
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
      />}
    />
  )
}

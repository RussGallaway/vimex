import { createDirectoryNavigation } from "./directories"
import {
  createHandoffDestinations,
  parseHandoffDestinationState,
} from "./handoff-destinations"
import { join, resolve } from "node:path"
import { version } from "../../../package.json"
import {
  emptyLocalState,
  parseLocalState,
  type LocalState,
} from "@vimex/workbench"
import {
  CliRenderEvents,
  createCliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
} from "@opentui/core"
import { createRoot } from "@opentui/react"
import {
  ConnectedVimexRoot,
  FatalBoundary,
  registerSyntaxParsers,
} from "@vimex/ui-opentui-react"
import {
  createCaffeinate,
  JsonStore,
  stateDirectory,
  configDirectory,
  loadConfig,
  parseConfig,
  openUrl,
  resolveMachineDirectory,
  prepareLegacyHandoff,
} from "@vimex/platform-node"
import {
  createHerdrExternalActions,
  detectHerdr,
  HerdrReporter,
} from "@vimex/herdr"
import { createElement } from "react"
import type { CliOptions } from "./cli-options"
import {
  FailureNotice,
  failureAfterCleanup,
  Lifecycle,
  shutdownApplication,
} from "./lifecycle"
import { createCodexGateways } from "@vimex/codex-app-server"
import { createDemoGateway } from "./demo-gateway"
import { VimexController } from "@vimex/workbench"
import { imageInput } from "./images"
import {
  nativeHandoff,
  nativeHandoffPreflight,
  type NativeHandoffOptions,
} from "./native-handoff"
import { createMachineNavigation } from "./machine-navigation"
import { PerformanceProfileRecorder } from "./performance-profile"

export async function runApplication(options: CliOptions) {
  let controller!: VimexController
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
  const performanceProfile = new PerformanceProfileRecorder({
    metadata: {
      vimexVersion: version,
      bunVersion: process.versions.bun,
      viewportRows: process.stdout.rows,
      viewportColumns: process.stdout.columns,
    },
  })
  const startupPhase = (phase: string, atMs = performance.now()) =>
    performanceProfile.recordStartupPhase(phase, atMs)
  let pendingNavigationFrame:
    { operationId: string; burstId?: string } | undefined
  let frameAwaitingCompletion = false
  const framedNavigationIds = new Set<string>()
  const pendingSubmitFrames = new Set<string>()
  const recordPerformanceMark = (
    mark: Parameters<typeof performanceProfile.record>[0],
  ) => {
    if (mark.phase === "input" || mark.phase === "attempted")
      startupPhase("first_input", mark.atMs)
    if (mark.kind === "submit" && mark.phase === "next_thread_activity")
      startupPhase("first_server_activity", mark.atMs)
    if (mark.kind === "submit" && mark.phase === "next_thread_content")
      startupPhase("first_assistant_delta", mark.atMs)
    performanceProfile.record({
      ...mark,
      detail: {
        ...mark.detail,
        viewportRows: renderer?.height ?? process.stdout.rows,
        viewportColumns: renderer?.width ?? process.stdout.columns,
      },
    })
    if (
      mark.kind === "navigation" &&
      mark.phase === "state_published" &&
      mark.operationId &&
      frameAwaitingCompletion &&
      renderer?.getSchedulerState().isRendering
    )
      performanceProfile.record({
        kind: "navigation",
        phase: "frame_already_running_at_publication",
        operationId: mark.operationId,
        burstId: mark.burstId,
        atMs: mark.atMs,
        detail: { rendererFrameId: renderer.frameId },
      })
    if (
      mark.kind === "navigation" &&
      mark.operationId &&
      mark.phase === "state_published"
    ) {
      if (framedNavigationIds.has(mark.operationId)) return
      if (
        pendingNavigationFrame &&
        pendingNavigationFrame.operationId !== mark.operationId
      ) {
        performanceProfile.record({
          kind: "navigation",
          phase: "superseded",
          operationId: pendingNavigationFrame.operationId,
          burstId: pendingNavigationFrame.burstId,
          atMs: mark.atMs,
        })
      }
      pendingNavigationFrame = {
        operationId: mark.operationId,
        burstId: mark.burstId,
      }
    }
    if (
      mark.kind === "submit" &&
      mark.phase === "next_thread_content_committed" &&
      mark.operationId
    ) {
      pendingSubmitFrames.add(mark.operationId)
      if (pendingSubmitFrames.size > 128)
        pendingSubmitFrames.delete(pendingSubmitFrames.values().next().value!)
    }
  }
  let config = await loadConfig(options.config)
  const configStore = new JsonStore(
    options.config ?? join(configDirectory(), "config.json"),
    parseConfig,
  )
  let configWrites = Promise.resolve()
  const updateConfig = (patch: Partial<typeof config>) => {
    const operation = configWrites
      .catch(() => {})
      .then(async () => {
        const next = { ...config, ...patch }
        await configStore.write(next)
        config = next
      })
    configWrites = operation
    return operation
  }
  const initialMachine = options.machine ?? "local"
  const localStores = new Map<string, JsonStore<LocalState>>()
  const machineViews = new Map<string, LocalState>()
  const savedViews = new Map<string, string>()
  const loadMachineState = async (id: string) => {
    if (machineViews.has(id)) return machineViews.get(id)!
    const store = new JsonStore(
      join(
        stateDirectory(),
        id === "local" ? "views.json" : `views-${id}.json`,
      ),
      parseLocalState,
    )
    const state = options.demo
      ? emptyLocalState()
      : await store.read(emptyLocalState())
    if (!options.demo) localStores.set(id, store)
    machineViews.set(id, state)
    savedViews.set(id, JSON.stringify(state))
    return state
  }
  let localState = await loadMachineState(initialMachine)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let persistenceError: unknown
  const persistenceNotice = new FailureNotice()
  const save = async () => {
    saveTimer = undefined
    try {
      for (const [id, state] of machineViews) {
        const store = localStores.get(id)
        if (!store) continue
        const json = JSON.stringify(state)
        if (json === savedViews.get(id)) continue
        await store.write(state)
        savedViews.set(id, json)
      }
      persistenceError = undefined
      persistenceNotice.clear()
    } catch (error) {
      persistenceError = error
      persistenceNotice.fail(error, (message) =>
        controller.notice(`Local view state is not being saved: ${message}`),
      )
    }
  }
  const lifecycle = new Lifecycle()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const onFailure = (error: unknown) => {
    process.exitCode = 1
    failure ??= error ?? new Error("Unknown runtime failure")
    finish()
  }
  let failure: unknown
  let cleanupFailure: unknown
  let lastHerdrError: string | undefined
  let root: ReturnType<typeof createRoot> | undefined
  let detachHandlers = () => {}
  try {
    renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
      useKittyKeyboard:
        process.env.VIMEX_NAV_REPEAT_CONTROL === "1"
          ? { events: true }
          : undefined,
    })
    startupPhase("renderer_created")
    const activeRenderer = renderer
    const onFrameStart = async () => {
      frameAwaitingCompletion = true
      const atMs = performance.now()
      if (pendingNavigationFrame)
        performanceProfile.record({
          kind: "navigation",
          phase: "frame_callback_start",
          operationId: pendingNavigationFrame.operationId,
          burstId: pendingNavigationFrame.burstId,
          atMs,
          detail: { rendererFrameId: activeRenderer.frameId },
        })
      for (const operationId of pendingSubmitFrames)
        performanceProfile.record({
          kind: "submit",
          phase: "frame_callback_start",
          operationId,
          atMs,
          detail: { rendererFrameId: activeRenderer.frameId },
        })
    }
    const onFrame = () => {
      startupPhase("first_frame")
      frameAwaitingCompletion = false
      const atMs = performance.now()
      if (pendingNavigationFrame) {
        performanceProfile.record({
          kind: "navigation",
          phase: "next_renderer_frame",
          operationId: pendingNavigationFrame.operationId,
          burstId: pendingNavigationFrame.burstId,
          atMs,
          detail: {
            rendererFrameId: activeRenderer.frameId,
            viewportRows: activeRenderer.height,
            viewportColumns: activeRenderer.width,
          },
        })
        framedNavigationIds.add(pendingNavigationFrame.operationId)
        if (framedNavigationIds.size > 256)
          framedNavigationIds.delete(framedNavigationIds.values().next().value!)
        pendingNavigationFrame = undefined
      }
      for (const operationId of pendingSubmitFrames)
        performanceProfile.record({
          kind: "submit",
          phase: "next_frame_after_content_commit",
          operationId,
          atMs,
          detail: {
            rendererFrameId: activeRenderer.frameId,
            viewportRows: activeRenderer.height,
            viewportColumns: activeRenderer.width,
          },
        })
      pendingSubmitFrames.clear()
    }
    activeRenderer.setFrameCallback(onFrameStart)
    activeRenderer.on(CliRenderEvents.FRAME, onFrame)
    lifecycle.add(() => {
      activeRenderer.removeFrameCallback(onFrameStart)
      activeRenderer.off(CliRenderEvents.FRAME, onFrame)
    })
    const clipboard = createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(renderer),
    })
    lifecycle.add(() => clipboard.dispose())
    const images = imageInput(clipboard)
    lifecycle.add(async () => {
      if (!persistenceError) {
        // Retain image snapshots referenced by drafts on any visited machine.
        const combined = emptyLocalState()
        for (const [id, state] of machineViews)
          for (const [threadId, view] of Object.entries(state.threads))
            combined.threads[`${id}:${threadId}`] = view
        await images.cleanup(combined)
      }
    })
    const herdr = new HerdrReporter(options.demo ? undefined : detectHerdr())
    lifecycle.add(() => herdr.dispose())
    const externalActions = createHerdrExternalActions({
      fallbackOpenUrl: openUrl,
    })
    const power = createCaffeinate({
      platform: options.demo ? "demo" : undefined,
      enabled: config.caffeinate,
      saveEnabled: (caffeinate) => updateConfig({ caffeinate }),
    })
    lifecycle.add(() => power.dispose())
    const ports = {
      power,
      localState,
      busySubmit: config.busySubmit,
      preferences: {
        initial: { theme: config.theme, syntaxTheme: config.syntaxTheme },
        async save(preferences: import("@vimex/workbench").DisplayPreferences) {
          await updateConfig(preferences)
        },
      },
      clipboard: {
        writeText: async (text: string) => {
          await clipboard.writeText(text, { destination: "best-available" })
        },
      },
      images,
      openUrl: externalActions.openUrl,
      quit: finish,
      onPerformanceMark: recordPerformanceMark,
      async exportPerformance() {
        const filename = `vimex-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`
        const path = join(stateDirectory(), "profiles", filename)
        await performanceProfile.exportTo(path)
        return path
      },
      onLocalState(state: LocalState, machineId = initialMachine) {
        localState = state
        machineViews.set(machineId, state)
        if (localStores.size && !saveTimer)
          saveTimer = setTimeout(() => {
            void save()
          }, 200)
      },
      onLifecycle(
        state: import("@vimex/workbench").WorkbenchLifecycleSnapshot,
      ) {
        if (state.connection === "connected") startupPhase("connected")
        if (state.connection === "connected" && state.summary)
          startupPhase("session_bound")
        void herdr.report(state).catch((error) => {
          const message = `Herdr reporting failed: ${String(error)}`
          if (message !== lastHerdrError) {
            lastHerdrError = message
            controller.notice(message)
          }
        })
      },
    }
    const demo = options.demo ? createDemoGateway() : undefined
    const gateways = new Map<string, ReturnType<typeof createCodexGateways>>()
    const machineManager = createMachineNavigation({
      config,
      saveMachines: (machines, favoriteMachines) =>
        updateConfig({ machines, favoriteMachines }),
      initialMachine,
      localCwd: initialMachine === "local" ? options.cwd : process.cwd(),
      remoteCwd: options.remoteCwd,
      loadState: loadMachineState,
      resolveRemoteDirectory: resolveMachineDirectory,
      createRuntime(target, cwd) {
        const gateway = createCodexGateways(cwd, target.executable, undefined, {
          machine: target,
        })
        gateways.set(target.id, gateway)
        return {
          ...gateway,
          directories: createDirectoryNavigation(target.sshHost),
        }
      },
    })
    const handoffDestinationStore = new JsonStore(
      join(stateDirectory(), "handoff-destinations.json"),
      parseHandoffDestinationState,
    )
    const handoffDestinations = createHandoffDestinations({
      target: machineManager.target,
      directory: machineManager.directory,
      store: handoffDestinationStore,
    })
    machineManager.navigation.listHandoffDestinations = handoffDestinations.list
    machineManager.navigation.setHandoffDestinationFavorite =
      handoffDestinations.setFavorite
    const handoffOptions: NativeHandoffOptions = {
      navigation: machineManager.navigation,
      gateways,
      target: machineManager.target,
      prepare: prepareLegacyHandoff,
      rememberDestination: handoffDestinations.remember,
      notice: (message) => controller.notice(message),
    }
    machineManager.navigation.handoff = nativeHandoff(handoffOptions)
    machineManager.navigation.preflightHandoff = (input) =>
      nativeHandoffPreflight(handoffOptions, input)
    root = createRoot(renderer)
    if (!demo && initialMachine !== "local")
      root.render(
        createElement("text", null, `Connecting to ${initialMachine}…`),
      )
    const initialRuntime = demo
      ? undefined
      : await machineManager.navigation.open(initialMachine)
    const initialCwd = initialRuntime?.cwd ?? options.cwd
    controller = demo
      ? new VimexController({
          ...ports,
          conversation: demo,
          approvals: demo,
          connection: demo,
          models: demo,
          resolveDirectory: resolve,
        })
      : new VimexController({
          ...initialRuntime!,
          machines: machineManager.navigation,
          ...ports,
          resolveDirectory: initialRuntime?.resolveDirectory ?? resolve,
        })
    if (!options.thread && !options.resumeMode)
      controller.prepareDraft(initialCwd, options.model)
    lifecycle.add(async () => {
      if (saveTimer) clearTimeout(saveTimer)
      await save()
      await Promise.all([...localStores.values()].map((store) => store.flush()))
      if (persistenceError) throw persistenceError
    })
    lifecycle.add(() => controller.close())
    const stop = () => finish()
    for (const signal of signals) process.on(signal, stop)
    process.on("uncaughtException", onFailure)
    process.on("unhandledRejection", onFailure)
    detachHandlers = () => {
      for (const signal of signals) process.off(signal, stop)
      process.off("uncaughtException", onFailure)
      process.off("unhandledRejection", onFailure)
    }
    root.render(
      createElement(
        FatalBoundary,
        { onFatal: onFailure },
        createElement(ConnectedVimexRoot, {
          controller,
          settings: {
            ...config,
            reducedColor: config.reducedColor || Boolean(process.env.NO_COLOR),
          },
        }),
      ),
    )
    // Syntax parsers are needed for transcript content, not for the first
    // composer frame. Let the renderer establish the shell before loading
    // their native resources.
    const syntaxTimer = setTimeout(() => {
      try {
        registerSyntaxParsers()
      } catch (error) {
        controller.notice(`Syntax highlighting unavailable: ${String(error)}`)
      }
    }, 0)
    lifecycle.add(() => clearTimeout(syntaxTimer))
    void controller
      .initialize(initialCwd, options.model, options.thread, options.resumeMode)
      .catch((error) => {
        if (options.resumeMode) onFailure(error)
        else controller.notice(String(error))
      })
    await finished
  } catch (error) {
    failure ??= error ?? new Error("Unknown runtime failure")
  } finally {
    try {
      await shutdownApplication({
        unmount: () => root?.unmount(),
        restoreTerminal: () => renderer?.destroy(),
        releaseResources: () => lifecycle.close(),
        detachHandlers,
      })
    } catch (error) {
      cleanupFailure = error
    }
  }
  const terminalFailure = failureAfterCleanup(failure, cleanupFailure)
  if (terminalFailure !== undefined) throw terminalFailure
}

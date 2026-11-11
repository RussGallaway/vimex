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
  resolveRenderLib,
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
  paneIdentity,
  PaneStateStore,
  verifyRexPane,
  type PaneCheckpoint,
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
import { RexIntegration } from "./rex-integration"
import {
  mergeLocalChanges,
  mergeConfigPatch,
  navigationSeed,
  observePaneTarget,
} from "./pane-persistence"
import { openRestoredRuntime } from "./restored-runtime"

export async function runApplication(options: CliOptions) {
  const identity =
    !options.demo && process.stdout.isTTY ? paneIdentity() : undefined
  if (!identity) {
    if (options.restorePane) return
    return runApplicationWithPane(options)
  }
  try {
    await verifyRexPane(identity)
  } catch (error) {
    if (options.restorePane) throw error
    // Environment may be inherited by a different terminal (for example a PTY test).
    // Such a process must never claim or rewrite the original pane's checkpoint.
    console.error(`Vimex pane restoration is unavailable: ${String(error)}`)
    return runApplicationWithPane(options)
  }
  const store = new PaneStateStore(identity)
  const release = await store.acquire()
  if (!release) {
    if (options.restorePane) return
    throw new Error("Vimex is already running in this Rex pane")
  }
  try {
    const previous = await store.read()
    if (options.restorePane && !previous?.active) return
    if (options.restorePane && previous) {
      const target = previous.target
      options = {
        ...options,
        cwd: target.machine === "local" ? target.cwd : target.localCwd,
        remoteCwd: target.machine === "local" ? undefined : target.cwd,
        machine: target.machine,
        thread: target.thread,
        config: target.config,
        model: target.model,
      }
    }
    const checkpoint: PaneCheckpoint = {
      version: 1,
      instanceId: previous?.instanceId ?? crypto.randomUUID(),
      active: true,
      target: {
        machine: options.machine ?? "local",
        cwd: options.remoteCwd ?? options.cwd,
        localCwd: options.cwd,
        ...(options.thread ? { thread: options.thread } : {}),
        ...(options.config ? { config: options.config } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.restorePane && previous?.target.draftId
          ? { draftId: previous.target.draftId }
          : {}),
        ...(options.restorePane && previous?.target.sshHost
          ? { sshHost: previous.target.sshHost }
          : {}),
      },
      machines: previous?.machines ?? {},
    }
    await store.write(checkpoint)
    await runApplicationWithPane(options, { store, checkpoint })
  } finally {
    await release()
  }
}

async function runApplicationWithPane(
  options: CliOptions,
  pane?: { store: PaneStateStore; checkpoint: PaneCheckpoint },
) {
  let controller!: VimexController
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
  let rex: RexIntegration | undefined
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
        const before = config
        await configStore.update(before, (latest) =>
          mergeConfigPatch(latest, before, patch),
        )
        // Keep the baseline owned by this client. Adopting another client's map
        // here would turn its unseen additions into deletions on our next edit.
        config = { ...before, ...patch }
      })
    configWrites = operation
    return operation
  }
  const initialMachine = options.machine ?? "local"
  const localStores = new Map<string, JsonStore<LocalState>>()
  const machineViews = new Map<string, LocalState>()
  const savedViews = new Map<string, string>()
  const previousViews = new Map<string, LocalState>()
  const favoriteStores = new Map<string, JsonStore<LocalState>>()
  const previousFavorites = new Map<string, LocalState>()
  let checkpoint = pane?.checkpoint
  let savedCheckpoint = checkpoint ? JSON.stringify(checkpoint) : undefined
  let explicitQuit = false
  const loadMachineState = async (id: string) => {
    if (machineViews.has(id)) return machineViews.get(id)!
    const store = new JsonStore(
      join(
        stateDirectory(),
        id === "local" ? "views.json" : `views-${id}.json`,
      ),
      parseLocalState,
    )
    const legacy =
      options.demo || checkpoint?.machines[id]
        ? emptyLocalState()
        : await store.read(emptyLocalState())
    let state = checkpoint
      ? (checkpoint.machines[id] ?? navigationSeed(legacy))
      : legacy
    if (!options.demo) {
      const favorites = new JsonStore(
        join(stateDirectory(), `thread-preferences-${id}.json`),
        parseLocalState,
      )
      const shared = await favorites.read({
        ...emptyLocalState(),
        favoriteThreadIds: state.favoriteThreadIds ?? [],
      })
      state = { ...state, favoriteThreadIds: shared.favoriteThreadIds ?? [] }
      favoriteStores.set(id, favorites)
      previousFavorites.set(id, {
        ...emptyLocalState(),
        favoriteThreadIds: state.favoriteThreadIds,
      })
    }
    if (!options.demo && !pane) localStores.set(id, store)
    previousViews.set(id, state)
    machineViews.set(id, state)
    savedViews.set(id, JSON.stringify(state))
    return state
  }
  let localState = await loadMachineState(initialMachine)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let persistenceError: unknown
  const persistenceNotice = new FailureNotice()
  let persistenceWrites = Promise.resolve()
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    const operation = persistenceWrites
      .catch(() => {})
      .then(async () => {
        try {
          if (pane && checkpoint) {
            checkpoint = {
              ...checkpoint,
              active: !explicitQuit,
              machines: {
                ...checkpoint.machines,
                ...Object.fromEntries(machineViews),
              },
            }
            const json = JSON.stringify(checkpoint)
            if (json !== savedCheckpoint) {
              await pane.store.write(checkpoint)
              savedCheckpoint = json
            }
          }
          for (const [id, state] of machineViews) {
            const favorites = favoriteStores.get(id)
            if (favorites) {
              const before = previousFavorites.get(id) ?? emptyLocalState()
              const after = {
                ...emptyLocalState(),
                favoriteThreadIds: state.favoriteThreadIds,
              }
              if (JSON.stringify(before) !== JSON.stringify(after)) {
                await favorites.update(before, (latest) =>
                  mergeLocalChanges(latest, before, after),
                )
                previousFavorites.set(id, after)
              }
            }
            const store = localStores.get(id)
            if (!store) continue
            const json = JSON.stringify(state)
            if (json === savedViews.get(id)) continue
            const before = previousViews.get(id) ?? emptyLocalState()
            await store.update(emptyLocalState(), (latest) =>
              mergeLocalChanges(latest, before, state),
            )
            previousViews.set(id, state)
            savedViews.set(id, json)
          }
          persistenceError = undefined
          persistenceNotice.clear()
        } catch (error) {
          persistenceError = error
          persistenceNotice.fail(error, (message) =>
            controller?.notice(
              `Local view state is not being saved: ${message}`,
            ),
          )
        }
      })
    persistenceWrites = operation
    return operation
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
  const startupCancelled = Symbol("restoration cancelled")
  let cleanupFailure: unknown
  let lastHerdrError: string | undefined
  const rexNotice = new FailureNotice()
  let root: ReturnType<typeof createRoot> | undefined
  let detachHandlers = () => {}
  const startupAbort = new AbortController()
  void finished.then(() => startupAbort.abort())
  lifecycle.add(() => startupAbort.abort())
  const stop = () => finish()
  for (const signal of signals) process.on(signal, stop)
  process.on("uncaughtException", onFailure)
  process.on("unhandledRejection", onFailure)
  detachHandlers = () => {
    for (const signal of signals) process.off(signal, stop)
    process.off("uncaughtException", onFailure)
    process.off("unhandledRejection", onFailure)
  }
  lifecycle.add(async () => {
    await save()
    await Promise.all([...localStores.values()].map((store) => store.flush()))
    if (persistenceError) throw persistenceError
  })
  try {
    renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
      useKittyKeyboard:
        process.env.VIMEX_NAV_REPEAT_CONTROL !== "0"
          ? { events: true }
          : undefined,
    })
    startupPhase("renderer_created")
    const activeRenderer = renderer
    rex = new RexIntegration({
      enabled: Boolean(
        process.env.REX_SESSION &&
        process.env.REX_BLOCK &&
        process.stdout.isTTY,
      ),
      write: (sequence) =>
        resolveRenderLib().writeOut(activeRenderer.rendererPtr, sequence),
      setTitle: (title) => activeRenderer.setTerminalTitle(title),
    })
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
    const images = imageInput(
      clipboard,
      pane ? join(pane.store.directory, "images") : undefined,
    )
    lifecycle.add(async () => {
      await save()
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
      quit: () => {
        explicitQuit = true
        finish()
      },
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
        if ((pane || localStores.size) && !saveTimer)
          saveTimer = setTimeout(() => {
            void save()
          }, 200)
      },
      onLifecycle(
        state: import("@vimex/workbench").WorkbenchLifecycleSnapshot,
      ) {
        if (checkpoint) {
          const next = observePaneTarget(
            checkpoint,
            state,
            state.resumeTarget
              ? machineManager.target(state.resumeTarget.machine).sshHost
              : undefined,
          )
          if (next !== checkpoint) {
            checkpoint = next
            // Conversation identity changes are semantic checkpoints, not token cadence.
            void save()
          }
        }
        try {
          rex?.report(state)
          rexNotice.clear()
        } catch (error) {
          rexNotice.fail(
            new Error(`Rex reporting failed: ${String(error)}`),
            (message) => controller.notice(message),
          )
        }
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
    let restoringInitialMachine = Boolean(options.restorePane)
    const machineManager = createMachineNavigation({
      config,
      saveMachines: (machines, favoriteMachines) =>
        updateConfig({ machines, favoriteMachines }),
      initialMachine,
      localCwd: options.cwd,
      remoteCwd: options.remoteCwd,
      loadState: loadMachineState,
      resolveRemoteDirectory: (host, cwd) => {
        if (
          restoringInitialMachine &&
          checkpoint?.target.sshHost &&
          host !== checkpoint.target.sshHost
        )
          throw new Error(
            "The saved machine's SSH connection has changed. Restore its configuration before retrying.",
          )
        return resolveMachineDirectory(host, cwd, startupAbort.signal)
      },
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
    const openRuntime = () => machineManager.navigation.open(initialMachine)
    const initialRuntime = demo
      ? undefined
      : options.restorePane
        ? await openRestoredRuntime(openRuntime, {
            finished,
            render(message) {
              root!.render(createElement("text", null, message))
            },
            onKey(handler) {
              activeRenderer.keyInput.on("keypress", handler)
              return () => activeRenderer.keyInput.off("keypress", handler)
            },
            quit() {
              explicitQuit = true
              finish()
            },
          })
        : await openRuntime()
    if (!demo && !initialRuntime) throw startupCancelled
    restoringInitialMachine = false
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
    if (!options.thread && !options.resumeMode) {
      const draftId = options.restorePane
        ? pane?.checkpoint.target.draftId
        : undefined
      const draft = draftId ? localState.threads[draftId] : undefined
      if (draftId) delete localState.threads[draftId]
      controller.prepareDraft(initialCwd, options.model, draft)
    }
    lifecycle.add(() => controller.close())
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
    if (error !== startupCancelled)
      failure ??= error ?? new Error("Unknown runtime failure")
  } finally {
    try {
      await shutdownApplication({
        unmount: () => root?.unmount(),
        restoreTerminal: () => {
          try {
            rex?.dispose()
          } finally {
            renderer?.destroy()
          }
        },
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

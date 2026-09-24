import { join, resolve } from "node:path"
import { version } from "../../../package.json"
import { emptyLocalState, parseLocalState } from "@vimex/workbench"
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
  JsonStore,
  stateDirectory,
  configDirectory,
  loadConfig,
  parseConfig,
  openUrl,
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
  let pendingNavigationFrame:
    { operationId: string; burstId?: string } | undefined
  let frameAwaitingCompletion = false
  const framedNavigationIds = new Set<string>()
  const pendingSubmitFrames = new Set<string>()
  const recordPerformanceMark = (
    mark: Parameters<typeof performanceProfile.record>[0],
  ) => {
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
  const localStore = options.demo
    ? undefined
    : new JsonStore(join(stateDirectory(), "views.json"), parseLocalState)
  let localState = localStore
    ? await localStore.read(emptyLocalState())
    : emptyLocalState()
  let savedJson = JSON.stringify(localState)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let persistenceError: unknown
  const persistenceNotice = new FailureNotice()
  const save = async () => {
    saveTimer = undefined
    if (!localStore) return
    const json = JSON.stringify(localState)
    if (json === savedJson) return
    try {
      await localStore.write(localState)
      savedJson = json
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
    registerSyntaxParsers()
    renderer = await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 60,
    })
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
      if (!persistenceError) await images.cleanup(localState)
    })
    const herdr = new HerdrReporter(options.demo ? undefined : detectHerdr())
    lifecycle.add(() => herdr.dispose())
    const externalActions = createHerdrExternalActions({
      fallbackOpenUrl: openUrl,
    })
    const ports = {
      localState,
      busySubmit: config.busySubmit,
      preferences: {
        initial: { theme: config.theme, syntaxTheme: config.syntaxTheme },
        async save(preferences: import("@vimex/workbench").DisplayPreferences) {
          const next = { ...config, ...preferences }
          await configStore.write(next)
          config = next
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
      onLocalState(state: import("@vimex/workbench").LocalState) {
        localState = state
        if (localStore && !saveTimer)
          saveTimer = setTimeout(() => {
            void save()
          }, 200)
      },
      onLifecycle(
        state: import("@vimex/workbench").WorkbenchLifecycleSnapshot,
      ) {
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
          ...createCodexGateways(options.cwd, config.codexExecutable),
          ...ports,
          resolveDirectory: resolve,
        })
    lifecycle.add(async () => {
      if (saveTimer) clearTimeout(saveTimer)
      await save()
      await localStore?.flush()
      if (persistenceError) throw persistenceError
    })
    lifecycle.add(() => controller.close())
    root = createRoot(renderer)
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
    void controller
      .initialize(
        options.cwd,
        options.model,
        options.thread,
        options.resumeMode,
      )
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

import { join, resolve } from "node:path"
import { emptyLocalState, parseLocalState } from "@vimex/workbench"
import {
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

export async function runApplication(options: CliOptions) {
  let controller!: VimexController
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
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
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

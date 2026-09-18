import { join, resolve } from "node:path"
import { captureLocalState, emptyLocalState, parseLocalState } from "@vimex/workbench"
import { createCliRenderer, createClipboard, createHostClipboard, createRendererClipboardAdapter } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { VimexRoot } from "@vimex/ui-opentui-react"
import { JsonStore, stateDirectory, loadConfig, openUrl } from "@vimex/platform-node"
import { detectHerdr, HerdrReporter } from "@vimex/herdr"
import { createElement, useSyncExternalStore } from "react"
import type { CliOptions } from "./cli-options"
import { failureAfterCleanup, Lifecycle } from "./lifecycle"
import { createCodexGateways } from "@vimex/codex-app-server"
import { createDemoGateway } from "./demo-gateway"
import { VimexController } from "@vimex/workbench"

export async function runApplication(options: CliOptions) {
  const config = await loadConfig(options.config)
  const localStore = options.demo ? undefined : new JsonStore(join(stateDirectory(), "views.json"), parseLocalState)
  let localState = localStore ? await localStore.read(emptyLocalState()) : emptyLocalState()
  let savedJson = JSON.stringify(localState)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let persistenceError: unknown
  const save = async () => {
    saveTimer = undefined
    if (!localStore) return
    const json = JSON.stringify(localState)
    if (json === savedJson) return
    try { await localStore.write(localState); savedJson = json; persistenceError = undefined }
    catch (error) { persistenceError = error }
  }
  const lifecycle = new Lifecycle()
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const onFailure = (error: unknown) => { process.exitCode = 1; failure ??= error ?? new Error("Unknown runtime failure"); finish() }
  let failure: unknown
  let cleanupFailure: unknown
  let lastHerdrError: string | undefined
  try {
    const renderer = await createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: false, exitSignals: [], targetFps: 60 })
    lifecycle.add(() => renderer.destroy())
    const clipboard = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
    lifecycle.add(() => clipboard.dispose())
    const herdr = new HerdrReporter(options.demo ? undefined : detectHerdr())
    lifecycle.add(() => herdr.dispose())
    const ports = {
      localState,
      clipboard: { writeText: async (text: string) => { await clipboard.writeText(text, { destination: "best-available" }) } },
      openUrl,
      quit: finish,
      onState(state: import("@vimex/workbench").WorkbenchState) {
        localState = captureLocalState(state, localState)
        if (localStore && !saveTimer) saveTimer = setTimeout(() => { void save() }, 200)
        const summary = state.activeThreadId ? state.summaries[state.activeThreadId] : undefined
        const pendingApprovals = state.approvals.order.filter(id => state.approvals.byId[id]?.threadId === summary?.id).length
        void herdr.report({ summary, connection: state.connection, pendingApprovals }).catch(error => {
          const message = `Herdr reporting failed: ${String(error)}`
          if (message !== lastHerdrError) { lastHerdrError = message; controller.notice(message) }
        })
      },
    }
    const demo = options.demo ? createDemoGateway() : undefined
    const controller: VimexController = demo
      ? new VimexController({ ...ports, conversation: demo, approvals: demo, connection: demo, models: demo, resolveDirectory: resolve })
      : new VimexController({ ...createCodexGateways(options.cwd, config.codexExecutable), ...ports, resolveDirectory: resolve })
    lifecycle.add(async () => {
      if (saveTimer) clearTimeout(saveTimer)
      await save()
      await localStore?.flush()
      if (persistenceError) throw persistenceError
    })
    lifecycle.add(() => controller.close())
    const root = createRoot(renderer)
    lifecycle.add(() => root.unmount())
    const stop = () => finish()
    for (const signal of signals) process.on(signal, stop)
    process.on("uncaughtException", onFailure)
    process.on("unhandledRejection", onFailure)
    lifecycle.add(() => {
      for (const signal of signals) process.off(signal, stop)
      process.off("uncaughtException", onFailure)
      process.off("unhandledRejection", onFailure)
    })
    function ConnectedApp() {
      const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
      return createElement(VimexRoot, { state, controller, settings: config })
    }
    root.render(createElement(ConnectedApp))
    void controller.initialize(options.cwd, options.model, options.thread).catch(error => controller.notice(String(error)))
    await finished
  } catch (error) {
    failure ??= error ?? new Error("Unknown runtime failure")
  } finally {
    try { await lifecycle.close() } catch (error) { cleanupFailure = error }
  }
  const terminalFailure = failureAfterCleanup(failure, cleanupFailure)
  if (terminalFailure !== undefined) throw terminalFailure
}

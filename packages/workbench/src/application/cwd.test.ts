import { expect, test } from "bun:test"
import { threadId, turnId, type ThreadSummary } from "@vimex/conversation"
import { VimexController } from "./workbench-controller"
import type { MachineRuntime } from "./machines"
import type { RuntimeEvent } from "./runtime-connection"

function runtime(id: string) {
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const calls = { close: 0, restart: 0, resumes: [] as string[], sends: 0 }
  const summary = (thread = "same"): ThreadSummary => ({
    id: threadId(thread),
    title: `${id} thread`,
    cwd: `/${id}`,
    model: "test",
    reasoningEffort: "high",
    status: "idle",
  })
  const value: MachineRuntime = {
    machine: { id },
    cwd: `/${id}`,
    resolveDirectory: (_base, path) => path,
    conversation: {
      listThreads: async () => [summary()],
      startThread: async () => ({ summary: summary(), events: [] }),
      resumeThread: async (thread) => {
        calls.resumes.push(thread)
        return { summary: summary(thread), events: [] }
      },
      forkThread: async () => {
        throw new Error("Unexpected fork")
      },
      startTurn: async () => {
        calls.sends++
        return []
      },
      steerTurn: async () => {},
      interruptTurn: async () => {},
      renameThread: async () => {},
      updateSettings: async () => {},
    },
    connection: {
      connect: async () => {},
      restart: async () => {
        calls.restart++
      },
      close: async () => {
        calls.close++
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    approvals: {} as never,
    models: { listModels: async () => [] },
  }
  return {
    value,
    calls,
    emit(event: RuntimeEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

function setup() {
  const source = runtime("local")
  const settings: string[] = []
  const shells: string[] = []
  let cwd = "/local"
  source.value.directories = {
    resolve: async (_base, path) => {
      if (path === "missing") throw new Error("Missing directory")
      return path
    },
    list: async (_base, path) => ({
      directory: path,
      parent: "/",
      entries: [{ cwd: "/project", label: "project" }],
    }),
  }
  source.value.conversation.updateSettings = async (_id, value) => {
    if (value.cwd) {
      cwd = value.cwd
      settings.push(cwd)
    }
  }
  source.value.conversation.shellCommand = async () => {
    shells.push(cwd)
  }
  const controller = new VimexController({
    ...source.value,
    resolveDirectory: (_base, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  return { controller, source, settings, shells }
}
test("validated cwd applies before shell; failure preserves usable old cwd and command draft during pending change", async () => {
  const h = setup()
  await h.controller.initialize("/local", undefined, "same")
  h.source.emit({ type: "reconnected" })
  h.controller.executeCommand('cwd "/space project"')
  h.controller.dispatch({ type: "composer.change", text: "!pwd" })
  expect(h.controller.submit("next-turn")).toBe(false)
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe("!pwd")
  await h.controller.settle()
  expect(h.settings).toEqual(["/space project"])
  expect(h.controller.getSnapshot().summaries.same?.cwd).toBe("/space project")
  h.controller.executeCommand("cwd missing")
  await h.controller.settle()
  expect(h.settings).toEqual(["/space project"])
  expect(h.controller.getSnapshot().summaries.same?.cwd).toBe("/space project")
  expect(h.controller.submit("next-turn")).toBe(true)
  await h.controller.settle()
  expect(h.shells).toEqual(["/space project"])
  await h.controller.close()
})
test("cwd picker browses without mutating settings, choosing applies directory", async () => {
  const h = setup()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("cwd")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same?.interaction.overlay).toBe(
    "cwd",
  )
  h.controller.browseCwd("/project")
  await h.controller.settle()
  expect(h.controller.getSnapshot().cwdPicker?.listing?.directory).toBe(
    "/project",
  )
  expect(h.settings).toEqual([])
  h.controller.chooseCwd("/project")
  await h.controller.settle()
  expect(h.settings).toEqual(["/project"])
  expect(
    h.controller.getSnapshot().workspaces.same?.interaction.overlay,
  ).not.toBe("cwd")
  await h.controller.close()
})

test("directory changes wait for running shell commands and stale browsing never replaces a newer listing", async () => {
  const h = setup()
  let finishShell!: () => void
  h.source.value.conversation.shellCommand = async () =>
    new Promise<void>((resolve) => {
      finishShell = resolve
    })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "!sleep 1" })
  expect(h.controller.submit("next-turn")).toBe(true)
  await Promise.resolve()
  h.controller.executeCommand("cwd /project")
  expect(h.settings).toEqual([])
  finishShell()
  await h.controller.settle()
  let finishFirst!: (value: import("./directories").DirectoryListing) => void
  h.source.value.directories!.list = async (_base, path) =>
    path === "/local"
      ? new Promise((resolve) => {
          finishFirst = resolve
        })
      : { directory: path, entries: [] }
  h.controller.executeCommand("cwd")
  await Promise.resolve()
  h.controller.browseCwd("/newer")
  await Promise.resolve()
  finishFirst({ directory: "/stale", entries: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().cwdPicker?.listing?.directory).toBe(
    "/newer",
  )
  await h.controller.close()
})

import { expect, test } from "bun:test"
import { threadId, turnId, type ThreadSummary } from "@vimex/conversation"
import { VimexController } from "./workbench-controller"
import type { MachineNavigation, MachineRuntime } from "./machines"
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
function harness(
  open?: MachineNavigation["open"],
  handoff?: MachineNavigation["handoff"],
  management: Partial<MachineNavigation> = {},
  power?: import("./power-control").PowerControl,
) {
  const local = runtime("local"),
    remote = runtime("devbox")
  const saved: string[] = []
  const controller = new VimexController({
    ...local.value,
    power,
    resolveDirectory: (_base, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
    onLocalState: (_state, machine) => {
      saved.push(machine!)
    },
    machines: {
      current: { id: "local" },
      list: () => [{ id: "local" }, { id: "devbox" }],
      open:
        open ?? (async (id) => (id === "local" ? local.value : remote.value)),
      handoff,
      ...management,
    },
  })
  return { controller, local, remote, saved }
}

test("machine picker and switch isolate identical thread ids and restore drafts on return", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "local draft" })
  h.controller.executeCommand("machine")
  expect(h.controller.getSnapshot().workspaces.same?.interaction.overlay).toBe(
    "machines",
  )
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  h.controller.openThread(threadId("same"))
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe("")
  h.controller.dispatch({ type: "composer.change", text: "remote draft" })
  h.controller.executeCommand("machine local")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "local draft",
  )
  expect(h.saved).toContain("devbox")
  await h.controller.close()
})

test("failed destination preparation keeps source connection and draft", async () => {
  const h = harness(async () => {
    throw new Error("offline")
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "keep" })
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe("keep")
  expect(h.local.calls.close).toBe(0)
  expect(h.controller.getSnapshot().machineDestination).toBeUndefined()
  expect(h.controller.getSnapshot().machineChanging).toBe(false)
  expect(h.controller.getSnapshot().connection).toBe("connected")
  expect(h.controller.getSnapshot().error).toContain("offline")
  await h.controller.close()
})

test("typing stays local while destination connects and submit is blocked", async () => {
  const gate = Promise.withResolvers<MachineRuntime>()
  let localRuntime: MachineRuntime
  const h = harness((id) =>
    id === "local" ? Promise.resolve(localRuntime) : gate.promise,
  )
  localRuntime = h.local.value
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  h.controller.dispatch({
    type: "composer.change",
    text: "typed while connecting",
  })
  expect(h.controller.submit("next-turn")).toBe(false)
  expect(h.controller.getSnapshot().machineDestination?.id).toBe("devbox")
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  gate.resolve(h.remote.value)
  await h.controller.settle()
  expect(h.controller.getSnapshot().machineDestination).toBeUndefined()
  h.controller.executeCommand("machine local")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "typed while connecting",
  )
  expect(h.local.calls.sends).toBe(0)
  await h.controller.close()
})

test("native handoff preserves draft with a different destination thread id", async () => {
  const remote = runtime("devbox")
  const h = harness(undefined, async () => ({
    ...remote.value,
    threadId: "moved",
  }))
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "continue here" })
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("moved"))
  expect(h.controller.getSnapshot().workspaces.moved?.composer.text).toBe(
    "continue here",
  )
  await h.controller.close()
})

test("same-ID tree handoff preserves the latest draft and adopts each machine on roundtrip", async () => {
  const commits: string[] = []
  let h: ReturnType<typeof harness>
  h = harness(undefined, async ({ targetId, threadId }) => ({
    ...(targetId === "local" ? h.local.value : h.remote.value),
    threadId,
    commit: async () => {
      commits.push(targetId)
    },
  }))
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "outbound draft" })
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("same"))
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "outbound draft",
  )
  expect(h.controller.getSnapshot().summaries.same?.cwd).toBe("/devbox")
  h.controller.dispatch({ type: "composer.change", text: "new return draft" })
  h.controller.executeCommand("handoff local")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("same"))
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "new return draft",
  )
  expect(h.controller.getSnapshot().summaries.same?.cwd).toBe("/local")
  expect(commits).toEqual(["devbox", "local"])
  expect(h.local.calls.close).toBe(1)
  expect(h.remote.calls.close).toBe(1)
  h.remote.emit({ type: "disconnected", message: "stale remote proxy" })
  expect(h.controller.getSnapshot().connection).toBe("connected")
  expect(h.local.calls.sends + h.remote.calls.sends).toBe(0)
  await h.controller.close()
})

test("unsupported handoff never silently creates a replacement conversation", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  expect(h.controller.getSnapshot().error).toContain("not supported")
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.local.calls.close).toBe(0)
  await h.controller.close()
})

test("proxy reconnect resumes authoritative thread without restarting daemon or resending", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "draft" })
  h.local.emit({ type: "disconnected", message: "network down" })
  h.local.emit({ type: "reconnected" })
  await h.controller.settle()
  expect(h.local.calls.restart).toBe(0)
  expect(h.local.calls.resumes).toEqual(["same", "same"])
  expect(h.controller.getSnapshot().connection).toBe("connected")
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "draft",
  )
  expect(h.local.calls.sends).toBe(0)
  await h.controller.close()
})

test("handoff preparation failure rolls back before committing ownership", async () => {
  const target = runtime("devbox")
  let commits = 0,
    rollbacks = 0
  target.value.conversation.resumeThread = async () => {
    throw new Error("incompatible history")
  }
  const h = harness(undefined, async () => ({
    ...target.value,
    threadId: "moved",
    commit: async () => {
      commits++
    },
    rollback: async () => {
      rollbacks++
    },
  }))
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  expect(commits).toBe(0)
  expect(rollbacks).toBe(1)
  expect(h.local.calls.close).toBe(0)
  expect(target.calls.close).toBe(1)
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  await h.controller.close()
})

test("explicit SSH aliases can be opened without appearing in the picker", async () => {
  const other = runtime("new-host")
  const h = harness(async () => other.value)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine new-host")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("new-host")
  await h.controller.close()
})

test("reconnect keeps edits made while authoritative history is loading", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "before reconnect" })
  const resume = h.local.value.conversation.resumeThread
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof resume>>>()
  h.local.value.conversation.resumeThread = () => gate.promise
  h.local.emit({ type: "disconnected", message: "network down" })
  h.local.emit({ type: "reconnected" })
  h.controller.dispatch({
    type: "composer.change",
    text: "typed during reconnect",
  })
  gate.resolve(await resume(threadId("same")))
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "typed during reconnect",
  )
  await h.controller.close()
})

test("direct thread mutations cannot reach source while machine switch is preparing", async () => {
  const gate = Promise.withResolvers<MachineRuntime>()
  const h = harness(() => gate.promise)
  let renamed = 0
  h.local.value.conversation.renameThread = async () => {
    renamed++
  }
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  h.controller.renameThread(threadId("same"), "must not reach source")
  await Promise.resolve()
  expect(renamed).toBe(0)
  gate.resolve(h.remote.value)
  await h.controller.settle()
  expect(renamed).toBe(0)
  await h.controller.close()
})

test("reconnect reconciles accepted messages instead of offering a duplicate retry", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "accepted remotely" })
  const pending =
    Promise.withResolvers<
      readonly import("@vimex/conversation").ConversationEvent[]
    >()
  h.local.value.conversation.startTurn = () => pending.promise
  h.controller.submit("next-turn")
  const message =
    h.controller.getSnapshot().workspaces.same!.composer.outbox[0]!
  h.local.emit({ type: "disconnected", message: "lost acknowledgement" })
  pending.reject(new Error("disconnected"))
  const resume = h.local.value.conversation.resumeThread
  h.local.value.conversation.resumeThread = async (id) => ({
    ...(await resume(id)),
    events: [
      {
        type: "item.completed",
        threadId: id,
        item: {
          id: "server-user" as never,
          turnId: "turn" as never,
          kind: "user",
          status: "complete",
          markdown: message.text,
          clientMessageId: message.id,
        },
      },
    ],
  })
  h.local.emit({ type: "reconnected" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same!.composer.outbox).toEqual(
    [],
  )
  await h.controller.close()
})

test("new machine opens a real session so first message does not stall on a provisional id", async () => {
  const h = harness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().provisionalThreadIds).toEqual([])
  h.controller.dispatchInteraction({ type: "overlay.close" })
  h.controller.dispatch({
    type: "composer.change",
    text: "remote first message",
  })
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(h.remote.calls.sends).toBe(1)
  await h.controller.close()
})

test("cold reconnect binds a draft after an initial connection failure", async () => {
  const h = harness()
  h.local.value.connection.connect = async () => {
    throw new Error("offline")
  }
  h.controller.prepareDraft("/local")
  h.controller.dispatch({ type: "composer.change", text: "typed offline" })
  await expect(h.controller.initialize("/local")).rejects.toThrow("offline")
  h.local.emit({ type: "reconnected" })
  await h.controller.settle()
  expect(h.controller.getSnapshot().provisionalThreadIds).toEqual([])
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "typed offline",
  )
  h.controller.submit("next-turn")
  await h.controller.settle()
  expect(h.local.calls.sends).toBe(1)
  await h.controller.close().catch(() => {})
})

test("cold reconnect never replays an unacknowledged thread creation", async () => {
  const h = harness()
  let starts = 0
  h.local.value.conversation.startThread = async () => {
    starts++
    throw new Error("lost reply")
  }
  h.controller.prepareDraft("/local")
  await expect(h.controller.initialize("/local")).rejects.toThrow("lost reply")
  h.local.emit({ type: "reconnected" })
  await h.controller.settle()
  expect(starts).toBe(1)
  expect(h.controller.getSnapshot().error).toContain("not replayed")
  await h.controller.close().catch(() => {})
})

test("handoff refuses host-bound draft references without changing the draft", async () => {
  let transfers = 0
  const remote = runtime("devbox")
  const h = harness(undefined, async () => {
    transfers++
    return { ...remote.value, threadId: "moved" }
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.attachMention(
    { kind: "file", name: "index.ts", path: "/local/index.ts" },
    0,
  )
  const draft = h.controller.getSnapshot().workspaces.same!.composer.text
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  expect(transfers).toBe(0)
  expect(h.controller.getSnapshot().workspaces.same!.composer.text).toBe(draft)
  expect(h.controller.getSnapshot().error).toContain("reselect")
  await h.controller.close()
})

test("references cannot be attached while handoff prepares or commits", async () => {
  const gate = Promise.withResolvers<MachineRuntime & { threadId: string }>()
  const remote = runtime("devbox")
  let committed = false,
    rolledBack = false
  const h = harness(undefined, () => gate.promise)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  h.controller.attachMention(
    { kind: "skill", name: "test", path: "/local/SKILL.md" },
    0,
  )
  gate.resolve({
    ...remote.value,
    threadId: "moved",
    commit: async () => {
      await Promise.resolve()
      h.controller.attachMention(
        { kind: "file", name: "late.ts", path: "/local/late.ts" },
        0,
      )
      expect(
        h.controller.getSnapshot().workspaces.same!.composer.mentions,
      ).toEqual([])
      committed = true
    },
    rollback: async () => {
      rolledBack = true
    },
  })
  await h.controller.settle()
  expect(committed).toBe(true)
  expect(rolledBack).toBe(false)
  expect(h.controller.getSnapshot().machine!.id).toBe("devbox")
  expect(
    h.controller.getSnapshot().workspaces.moved!.composer.mentions,
  ).toEqual([])
  await h.controller.close()
})

function managedHarness(gate?: Promise<void>) {
  const entries = new Map<
    string,
    { id: string; label?: string; favorite?: boolean }
  >([
    ["local", { id: "local" }],
    ["devbox", { id: "devbox" }],
  ])
  const removed: string[] = []
  const h = harness(undefined, undefined, {
    list: () => [...entries.values()],
    add: async ({ id }) => {
      await gate
      entries.set(id, { id })
    },
    rename: async (id, label) => {
      await gate
      if (!entries.has(id)) throw new Error("Unknown machine")
      entries.set(id, { ...entries.get(id)!, label })
    },
    setFavorite: async (id, favorite) => {
      await gate
      if (!entries.has(id)) throw new Error("Unknown machine")
      entries.set(id, { ...entries.get(id)!, favorite })
    },
    remove: async (id) => {
      removed.push(id)
      entries.delete(id)
    },
  })
  return { ...h, entries, removed }
}

test("machine management adds connections and removes only inactive connections", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine add travel russ@vm")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machines?.map((m) => m.id)).toContain(
    "travel",
  )
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  h.controller.executeCommand("machine remove local")
  expect(h.removed).toEqual([])
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  h.controller.executeCommand("machine remove devbox")
  expect(h.removed).toEqual([])
  expect(h.controller.getSnapshot().error).toContain("Switch to another")
  h.controller.executeCommand("machine remove travel")
  await h.controller.settle()
  expect(h.removed).toEqual(["travel"])
  expect(h.controller.getSnapshot().machines?.map((m) => m.id)).not.toContain(
    "travel",
  )
  await h.controller.close()
})

test("renaming active and cached machines preserves stable ids and drafts", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  h.controller.openThread(threadId("same"))
  await h.controller.settle()
  h.controller.dispatch({ type: "composer.change", text: "remote draft" })
  h.controller.executeCommand("machine rename devbox Travel VM")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine).toEqual({
    id: "devbox",
    label: "Travel VM",
  })
  h.controller.executeCommand("machine local")
  await h.controller.settle()
  h.controller.executeCommand("machine rename devbox Work VM")
  await h.controller.settle()
  // Prepared runtime supplies the current label as the real navigation adapter does.
  h.remote.value.machine = h.entries.get("devbox")!
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine).toEqual({
    id: "devbox",
    label: "Work VM",
  })
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "remote draft",
  )
  await h.controller.close()
})

test("pending config saves prevent duplicate management and machine switching", async () => {
  const gate = Promise.withResolvers<void>()
  const h = managedHarness(gate.promise)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine rename devbox Travel")
  h.controller.executeCommand("machine remove devbox")
  expect(h.removed).toEqual([])
  h.controller.executeCommand("machine devbox")
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  gate.resolve()
  await h.controller.settle()
  expect(h.entries.get("devbox")?.label).toBe("Travel")
  h.controller.executeCommand("machine rename missing Missing")
  await h.controller.settle()
  expect(h.controller.getSnapshot().error).toContain("Unknown machine")
  h.controller.executeCommand("machine remove devbox")
  await h.controller.settle()
  expect(h.removed).toEqual(["devbox"])
  await h.controller.close()
})

test("incomplete management commands explain syntax without opening a connection", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  for (const command of [
    "machine add",
    "machine add vm",
    "machine rename devbox",
    "machine remove devbox extra",
  ]) {
    h.controller.executeCommand(command)
    expect(h.controller.getSnapshot().error).toContain("Usage:")
    expect(h.controller.getSnapshot().machine?.id).toBe("local")
  }
  await h.controller.close()
})

test("existing machine aliases named like management actions remain selectable", async () => {
  const destination = runtime("add")
  const h = harness(async () => destination.value, undefined, {
    list: () => [{ id: "local" }, { id: "add" }],
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine add")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.id).toBe("add")
  await h.controller.close()
})

test("readding a removed machine does not resume its old active thread", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  h.controller.openThread(threadId("old-host-thread"))
  await h.controller.settle()
  h.controller.executeCommand("machine local")
  await h.controller.settle()
  h.controller.executeCommand("machine remove devbox")
  await h.controller.settle()
  h.controller.executeCommand("machine add devbox new-host")
  await h.controller.settle()
  h.remote.calls.resumes.length = 0
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  expect(h.remote.calls.resumes).toEqual([])
  expect(h.controller.getSnapshot().activeThreadId).toBe(threadId("same"))
  await h.controller.close()
})

test("close waits for an already accepted machine configuration save", async () => {
  const gate = Promise.withResolvers<void>()
  const h = managedHarness(gate.promise)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine rename devbox Travel")
  let closed = false
  const closing = h.controller.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  gate.resolve()
  await closing
  expect(h.entries.get("devbox")?.label).toBe("Travel")
})

test("renaming an active connection keeps runtime events and composing live", async () => {
  const gate = Promise.withResolvers<void>()
  const h = managedHarness(gate.promise)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  h.controller.executeCommand("machine rename devbox Travel")
  h.remote.emit({
    type: "conversation",
    event: {
      type: "turn.started",
      threadId: threadId("same"),
      turnId: turnId("running"),
      startedAt: 123,
    },
  })
  h.controller.dispatch({ type: "composer.change", text: "still typing" })
  gate.resolve()
  await h.controller.settle()
  expect(h.remote.calls.close).toBe(0)
  expect(h.remote.calls.restart).toBe(0)
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "still typing",
  )
  expect(h.controller.getSnapshot().machine?.label).toBe("Travel")
  expect(
    h.controller.getSnapshot().workspaces.same?.conversation.activeTurnId,
  ).toBe(turnId("running"))
  await h.controller.close()
})

test("machine favorites toggle local and remote without changing the active runtime", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "keep this draft" })
  h.controller.dispatchInteraction({
    type: "overlay.open",
    overlay: "machines",
  })
  h.controller.executeNamedCommand("machine favorite local")
  expect(h.controller.getSnapshot().machineManagement).toEqual({
    pending: true,
  })
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine).toMatchObject({
    id: "local",
    favorite: true,
  })
  expect(h.controller.getSnapshot().machineManagement).toEqual({
    pending: false,
  })
  expect(h.controller.getSnapshot().workspaces.same?.interaction.overlay).toBe(
    "machines",
  )
  h.controller.executeNamedCommand("machine favorite devbox")
  await h.controller.settle()
  expect(
    h.controller
      .getSnapshot()
      .machines?.find((machine) => machine.id === "devbox")?.favorite,
  ).toBe(true)
  h.controller.executeNamedCommand("machine favorite local")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machine?.favorite).toBe(false)
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "keep this draft",
  )
  await h.controller.close()
})

test("machine forms receive validation and persistence errors and recover on retry", async () => {
  const h = managedHarness()
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeNamedCommand("machine favorite missing")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machineManagement).toEqual({
    pending: false,
    error: "Unknown machine",
  })
  h.controller.executeNamedCommand("machine rename local Laptop")
  expect(h.controller.getSnapshot().machineManagement?.error).toContain(
    "local machine",
  )
  h.controller.executeNamedCommand("machine favorite devbox extra")
  expect(h.controller.getSnapshot().machineManagement?.error).toContain(
    "Usage:",
  )
  h.controller.executeNamedCommand("machine favorite devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().machineManagement).toEqual({
    pending: false,
  })
  await h.controller.close()
})

test("unavailable machine management completes modal requests with an error", async () => {
  const local = runtime("local")
  const controller = new VimexController({
    ...local.value,
    resolveDirectory: (_base, path) => path,
    clipboard: { writeText: async () => {} },
    openUrl: async () => {},
    quit() {},
  })
  await controller.initialize("/local", undefined, "same")
  controller.executeNamedCommand("machine add devbox devbox")
  expect(controller.getSnapshot().machineManagement).toEqual({
    pending: false,
    error: "Machine connections are unavailable",
  })
  await controller.close()
})

test("a machine command during connection reports completion instead of hanging the form", async () => {
  const gate = Promise.withResolvers<MachineRuntime>()
  const h = harness(() => gate.promise)
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeNamedCommand("machine devbox")
  h.controller.executeNamedCommand("machine favorite local")
  expect(h.controller.getSnapshot().machineManagement).toEqual({
    pending: false,
    error: "Connecting to machine; commands are paused",
  })
  gate.resolve(h.remote.value)
  await h.controller.settle()
  await h.controller.close()
})

test("handoff picker discovers destinations and passes selected directory to transfer", async () => {
  const remote = runtime("devbox")
  let destination: string | undefined
  const h = harness(
    undefined,
    async (input) => {
      destination = input.destinationCwd
      return { ...remote.value, threadId: "continued" }
    },
    {
      listHandoffDestinations: async () => ({
        directory: "/ready",
        entries: [{ cwd: "/ready", label: "ready", kind: "worktree" }],
        preferredCwd: "/ready",
      }),
    },
  )
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  expect(h.controller.getSnapshot().workspaces.same?.interaction.overlay).toBe(
    "handoff",
  )
  expect(h.controller.getSnapshot().handoffPicker?.listing?.preferredCwd).toBe(
    "/ready",
  )
  expect(destination).toBeUndefined()
  h.controller.chooseHandoffDestination("/ready")
  await h.controller.settle()
  expect(destination).toBe("/ready")
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  expect(h.controller.getSnapshot().handoffPicker).toBeUndefined()
  await h.controller.close()
})

test("handoff directory browse ignores older and dismissed requests", async () => {
  const old =
    Promise.withResolvers<import("./machines").HandoffDestinationListing>()
  const h = harness(undefined, undefined, {
    listHandoffDestinations: async (input) =>
      input.directory === "/new"
        ? { directory: "/new", entries: [] }
        : old.promise,
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  h.controller.browseHandoffDestination("/new")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(h.controller.getSnapshot().handoffPicker?.listing?.directory).toBe(
    "/new",
  )
  h.controller.dispatchInteraction({ type: "overlay.close" })
  old.resolve({ directory: "/old", entries: [] })
  await h.controller.settle()
  expect(h.controller.getSnapshot().handoffPicker?.listing?.directory).toBe(
    "/new",
  )
  expect(
    h.controller.getSnapshot().workspaces.same?.interaction.overlay,
  ).toBeNull()
  await h.controller.close()
})

test("explicit handoff directory and isolated options bypass picker", async () => {
  for (const [argument, expected] of [
    ["devbox --cwd '/ready worktree'", "/ready worktree"],
    ["devbox --isolated", undefined],
  ] as const) {
    const remote = runtime("devbox")
    let actual: string | undefined = "not called"
    const h = harness(
      undefined,
      async (input) => {
        actual = input.destinationCwd
        return { ...remote.value, threadId: "continued" }
      },
      {
        listHandoffDestinations: async () => {
          throw new Error("Unexpected picker")
        },
      },
    )
    await h.controller.initialize("/local", undefined, "same")
    h.controller.executeCommand(`handoff ${argument}`)
    await h.controller.settle()
    if (expected === undefined) expect(actual).toBeUndefined()
    else expect(actual).toBe(expected)
    expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
    await h.controller.close()
  }
})

test("destination favorite errors stay visible and preserve choices", async () => {
  const h = harness(undefined, undefined, {
    listHandoffDestinations: async () => ({
      directory: "/ready",
      entries: [{ cwd: "/ready", label: "ready", kind: "worktree" }],
    }),
    setHandoffDestinationFavorite: async () => {
      throw new Error("disk full")
    },
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  h.controller.favoriteHandoffDestination("/ready")
  await h.controller.settle()
  expect(h.controller.getSnapshot().handoffPicker?.error).toContain("disk full")
  expect(
    h.controller.getSnapshot().handoffPicker?.listing?.entries,
  ).toHaveLength(1)
  expect(h.controller.getSnapshot().handoffPicker?.loading).toBe(false)
  await h.controller.close()
})

test("handoff preflight failures remain visible inside the destination picker", async () => {
  const h = harness(
    undefined,
    async () => {
      throw new Error("must not transfer")
    },
    {
      listHandoffDestinations: async () => ({
        directory: "/ready",
        entries: [],
      }),
    },
  )
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  h.local.emit({
    type: "conversation",
    event: {
      type: "turn.started",
      threadId: threadId("same"),
      turnId: turnId("busy"),
      startedAt: 1,
    },
  })
  await h.controller.settle()
  h.controller.chooseHandoffDestination("/ready")
  expect(h.controller.getSnapshot().handoffPicker?.error).toContain(
    "active turn",
  )
  await h.controller.close()
})

test("automatic wakefulness follows local turns, toggles, remote switching, and shutdown", async () => {
  let snapshot = { enabled: true, supported: true, active: false }
  const listeners = new Set<() => void>()
  const requirements: boolean[] = []
  let disposed = false
  const power: import("./power-control").PowerControl = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setRequired(value) {
      requirements.push(value)
      const active = value && snapshot.enabled
      if (active === snapshot.active) return
      snapshot = { ...snapshot, active }
      for (const listener of listeners) listener()
    },
    async setEnabled(enabled) {
      snapshot = { ...snapshot, enabled }
      for (const listener of listeners) listener()
    },
    dispose() {
      disposed = true
    },
  }
  const h = harness(undefined, undefined, {}, power)
  await h.controller.initialize("/local", undefined, "same")
  h.local.emit({
    type: "conversation",
    event: {
      type: "turn.started",
      threadId: threadId("same"),
      turnId: turnId("busy"),
      startedAt: 1,
    },
  })
  await h.controller.settle()
  expect(h.controller.getSnapshot().power?.active).toBe(true)
  h.controller.executeCommand("caffeinate off")
  await h.controller.settle()
  expect(h.controller.getSnapshot().power?.enabled).toBe(false)
  expect(h.controller.getSnapshot().power?.active).toBe(false)
  h.controller.executeCommand("caffeinate")
  await h.controller.settle()
  expect(h.controller.getSnapshot().power?.active).toBe(true)
  h.local.emit({
    type: "conversation",
    event: {
      type: "turn.completed",
      threadId: threadId("same"),
      turnId: turnId("busy"),
      outcome: "complete",
    },
  })
  await h.controller.settle()
  expect(h.controller.getSnapshot().power?.active).toBe(false)
  h.controller.executeCommand("machine devbox")
  await h.controller.settle()
  h.remote.emit({
    type: "conversation",
    event: {
      type: "turn.started",
      threadId: threadId("same"),
      turnId: turnId("remote"),
      startedAt: 2,
    },
  })
  await h.controller.settle()
  expect(requirements.at(-1)).toBe(false)
  await h.controller.close()
  expect(disposed).toBe(true)
})

test("handoff checks source eligibility before discovering destinations and retries inline", async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  let checks = 0
  const h = harness(undefined, undefined, {
    preflightHandoff: async () => {
      checks++
      if (checks === 1) await gate.promise
    },
    listHandoffDestinations: async () => {
      calls++
      return { directory: "/ready", entries: [] }
    },
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  expect(h.controller.getSnapshot().handoffPicker?.phase).toBe("checking")
  expect(calls).toBe(0)
  h.controller.browseHandoffDestination("/bypass")
  expect(calls).toBe(0)
  gate.reject(new Error("Unsupported history dependency"))
  await h.controller.settle()
  expect(h.controller.getSnapshot().handoffPicker?.preflightError).toBe(true)
  expect(h.controller.getSnapshot().handoffPicker?.error).toContain(
    "Unsupported history",
  )
  expect(calls).toBe(0)
  h.controller.browseHandoffDestination()
  await h.controller.settle()
  expect(checks).toBe(2)
  expect(calls).toBe(1)
  expect(h.controller.getSnapshot().handoffPicker?.preflightError).toBe(false)
  expect(h.controller.getSnapshot().handoffPicker?.listing?.directory).toBe(
    "/ready",
  )
  await h.controller.close()
})

test("dismissed handoff preflight cannot open a destination listing", async () => {
  const gate = Promise.withResolvers<void>()
  let listed = false
  const h = harness(undefined, undefined, {
    preflightHandoff: () => gate.promise,
    listHandoffDestinations: async () => {
      listed = true
      return { directory: "/ready", entries: [] }
    },
  })
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  h.controller.dispatchInteraction({ type: "overlay.close" })
  gate.resolve()
  await h.controller.settle()
  expect(listed).toBe(false)
  expect(
    h.controller.getSnapshot().workspaces.same?.interaction.overlay,
  ).toBeNull()
  await h.controller.close()
})

test("handoff progress retains picker and failure keeps destination for retry", async () => {
  const remote = runtime("devbox")
  const first = Promise.withResolvers<MachineRuntime & { threadId: string }>()
  let progress: ((phase: import("./machines").HandoffPhase) => void) | undefined
  let transfers = 0
  const listing = {
    directory: "/ready",
    entries: [
      {
        cwd: "/ready",
        label: "ready",
        kind: "worktree" as const,
        dirty: false,
      },
    ],
  }
  const h = harness(
    undefined,
    async (input) => {
      transfers++
      progress = input.onProgress
      if (transfers === 1) return first.promise
      return { ...remote.value, threadId: "continued" }
    },
    { listHandoffDestinations: async () => listing },
  )
  await h.controller.initialize("/local", undefined, "same")
  h.controller.dispatch({ type: "composer.change", text: "source draft" })
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  h.controller.chooseHandoffDestination("/ready")
  expect(h.controller.getSnapshot().workspaces.same?.interaction.overlay).toBe(
    "handoff",
  )
  expect(h.controller.getSnapshot().handoffPicker?.transferring).toBe(true)
  progress?.("restoring")
  expect(h.controller.getSnapshot().handoffPicker?.phase).toBe("restoring")
  first.reject(new Error("Restore failed"))
  await h.controller.settle()
  expect(h.controller.getSnapshot().handoffPicker?.listing).toBe(listing)
  expect(h.controller.getSnapshot().handoffPicker?.error).toContain(
    "Restore failed",
  )
  expect(h.controller.getSnapshot().handoffPicker?.transferring).toBe(false)
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().workspaces.same?.composer.text).toBe(
    "source draft",
  )
  const oldProgress = progress
  oldProgress?.("switching")
  expect(h.controller.getSnapshot().handoffPicker?.phase).toBeUndefined()
  h.controller.chooseHandoffDestination("/ready")
  await h.controller.settle()
  expect(transfers).toBe(2)
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  expect(h.controller.getSnapshot().handoffPicker).toBeUndefined()
  await h.controller.close()
})

test("source disconnect during destination connection rolls back before handoff commit", async () => {
  const gate = Promise.withResolvers<void>()
  const remote = runtime("devbox")
  let commits = 0
  let rollbacks = 0
  remote.value.connection.connect = () => gate.promise
  const h = harness(
    undefined,
    async () => ({
      ...remote.value,
      threadId: "continued",
      commit: async () => {
        commits++
      },
      rollback: async () => {
        rollbacks++
      },
    }),
    {
      listHandoffDestinations: async () => ({
        directory: "/ready",
        entries: [],
      }),
    },
  )
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  h.controller.chooseHandoffDestination("/ready")
  await new Promise((resolve) => setTimeout(resolve, 0))
  h.local.emit({ type: "disconnected", message: "network lost" })
  gate.resolve()
  await h.controller.settle()
  expect(commits).toBe(0)
  expect(rollbacks).toBe(1)
  expect(h.controller.getSnapshot().machine?.id).toBe("local")
  expect(h.controller.getSnapshot().handoffPicker?.error).toContain(
    "Source connection changed",
  )
  expect(h.controller.getSnapshot().machineChanging).toBe(false)
  await h.controller.close()
})

test("isolated handoff uses the selected repository as its base without choosing existing mode", async () => {
  const remote = runtime("devbox")
  let selected: { destinationCwd?: string; isolated?: boolean } | undefined
  const h = harness(
    undefined,
    async (input) => {
      selected = input
      return { ...remote.value, threadId: "continued" }
    },
    {
      listHandoffDestinations: async () => ({
        directory: "/home/dev/projects",
        entries: [
          {
            cwd: "/home/dev/projects/repo",
            label: "repo",
            kind: "worktree",
            dirty: true,
          },
        ],
      }),
    },
  )
  await h.controller.initialize("/local", undefined, "same")
  h.controller.executeCommand("handoff devbox")
  await h.controller.settle()
  h.controller.chooseHandoffDestination("/home/dev/projects/repo", true)
  await h.controller.settle()
  expect(selected?.destinationCwd).toBe("/home/dev/projects/repo")
  expect(selected?.isolated).toBe(true)
  expect(h.controller.getSnapshot().machine?.id).toBe("devbox")
  await h.controller.close()
})

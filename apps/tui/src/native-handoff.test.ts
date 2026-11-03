import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { nativeHandoff, type NativeHandoffOptions } from "./native-handoff"

function harness() {
  const events: string[] = []
  let historyMode = "legacy"
  let targetAccount = "account"
  const gateway = (host: string) => ({
    conversation: { listBackgroundTerminals: async () => [] },
    nativeHandoff: {
      referencedThreads: async () => [],
      assertPortable: async () => {},
      inspect: async () => ({
        historyMode,
        status: { type: "idle" },
        cwd: "/source",
        rolloutPath: "/history",
      }),
      accountIdentity: async () =>
        host === "local" ? "account" : targetAccount,
      forkFromPath: async () => {
        events.push("fork")
        return { summary: { id: "new-thread" } }
      },
      archiveSource: async () => {
        events.push(`archive-${host}`)
      },
    },
  })
  const options = {
    captureHistory: async () => ({
      files: [],
      threadId: "old",
      verifySourceUnchanged: async () => {},
    }),
    gateways: new Map([
      ["local", gateway("local")],
      ["devbox", gateway("devbox")],
    ]),
    navigation: {
      open: async () => ({
        machine: { id: "devbox" },
        cwd: "/destination",
        connection: {
          connect: async () => {
            events.push("connect")
          },
          close: async () => {
            events.push("close")
          },
        },
      }),
    },
    target: (id: string) => ({ id, sshHost: id === "local" ? undefined : id }),
    prepare: async () => {
      events.push("prepare")
      return {
        cwd: "/worktree",
        rolloutPath: "/copy",
        verifySourceUnchanged: async () => {
          events.push("verify")
        },
        finalize: async () => {
          events.push("finalize")
        },
        cleanup: async () => {
          events.push("cleanup")
        },
      }
    },
    notice: (message: string) => {
      events.push(message)
    },
  } as unknown as NativeHandoffOptions
  return {
    events,
    options,
    setHistory(value: string) {
      historyMode = value
    },
    setAccount(value: string) {
      targetAccount = value
    },
    run: () =>
      nativeHandoff(options)({
        sourceId: "local",
        targetId: "devbox",
        threadId: "old",
        cwd: "/source",
      }),
  }
}
test("native transfer does not retire source until destination validation commits", async () => {
  const h = harness()
  const result = await h.run()
  expect(result.threadId).toBe("new-thread")
  expect(h.events).not.toContain("archive-local")
  await result.commit!()
  expect(h.events.slice(-3)).toEqual(["verify", "archive-local", "finalize"])
  await result.rollback!()
  expect(h.events).not.toContain("cleanup")
})
test("unsupported history and mismatched accounts never transfer files", async () => {
  const h = harness()
  h.setHistory("future-format")
  await expect(h.run()).rejects.toThrow("not supported")
  expect(h.events).toEqual([])
  h.setHistory("legacy")
  h.setAccount("different")
  await expect(h.run()).rejects.toThrow("same signed-in")
  expect(h.events).not.toContain("prepare")
  expect(h.events).toContain("close")
})
test("unadopted destination rollback retires only imported thread and removes staged work", async () => {
  const h = harness()
  const result = await h.run()
  await result.rollback!()
  expect(h.events.slice(-2)).toEqual(["archive-devbox", "cleanup"])
  expect(h.events).not.toContain("archive-local")
})

test("uncertain source retirement preserves the prepared destination for recovery", async () => {
  const h = harness()
  h.options.gateways.get("local")!.nativeHandoff.archiveSource = async () => {
    h.events.push("archive-local-uncertain")
    throw new Error("Connection closed before acknowledgement")
  }
  const result = await h.run()
  await expect(result.commit!()).rejects.toThrow("were retained")
  await result.rollback!()
  expect(h.events).not.toContain("archive-devbox")
  expect(h.events).not.toContain("cleanup")
})

test("selected destination is prepared in existing mode and remembered only after source retirement", async () => {
  const h = harness()
  let opened: string | undefined
  let mode: string | undefined
  const originalOpen = h.options.navigation.open
  h.options.navigation.open = async (id, cwd) => {
    opened = cwd
    return originalOpen(id, cwd)
  }
  const originalPrepare = h.options.prepare
  h.options.prepare = async (request) => {
    mode = request.destinationMode
    return originalPrepare(request)
  }
  h.options.rememberDestination = async () => {
    h.events.push("remember")
  }
  const result = await nativeHandoff(h.options)({
    sourceId: "local",
    targetId: "devbox",
    threadId: "old",
    cwd: "/source",
    destinationCwd: "/prepared",
  })
  expect(opened).toBe("/prepared")
  expect(mode).toBe("existing")
  expect(h.events).not.toContain("remember")
  await result.commit!()
  expect(h.events.indexOf("remember")).toBeGreaterThan(
    h.events.indexOf("archive-local"),
  )
})

test("destination preference failure cannot roll back a committed handoff", async () => {
  const h = harness()
  const notices: string[] = []
  h.options.rememberDestination = async () => {
    throw new Error("disk full")
  }
  h.options.notice = (message) => {
    notices.push(message)
  }
  const result = await nativeHandoff(h.options)({
    sourceId: "local",
    targetId: "devbox",
    threadId: "old",
    cwd: "/source",
    destinationCwd: "/prepared",
  })
  await result.commit!()
  await result.rollback!()
  expect(notices.join(" ")).toContain("preference could not be saved")
  expect(h.events).not.toContain("cleanup")
})

test("paginated handoff imports native ancestry and verifies it before source retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-native-paginated-"))
  try {
    const h = harness()
    h.setHistory("paginated")
    h.options.captureHistory = undefined
    const path = join(root, "source.jsonl")
    await writeFile(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "old", history_mode: "paginated" },
      }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "exact history" }],
          },
        }) +
        "\n",
    )
    h.options.target = (id) => ({
      id,
      cwd: root,
      executable: "codex",
      mode: "stdio",
    })
    const source = h.options.gateways.get("local")!.nativeHandoff
    const target = h.options.gateways.get("devbox")!.nativeHandoff
    source.inspect = async () =>
      ({
        threadId: "old",
        historyMode: "paginated",
        status: { type: "idle" },
        cwd: root,
        rolloutPath: path,
      }) as never
    for (const native of [source, target]) {
      native.serverDetails = () => ({
        version: "0.166.0",
        codexHome: join(root, "home"),
      })
      native.historyDigest = async () => "1:exact"
      native.assertPortable = async () => {}
    }
    target.locate = async () => undefined
    target.archiveSource = async (id) => {
      h.events.push(`archive-dependency-${id}`)
    }
    target.hydrateHistory = async (id) => {
      h.events.push(`hydrate-${id}`)
    }
    const phases: string[] = []
    const result = await nativeHandoff(h.options)({
      sourceId: "local",
      targetId: "devbox",
      threadId: "old",
      cwd: root,
      onProgress: (phase) => phases.push(phase),
    })
    expect(h.events.indexOf("hydrate-old")).toBeLessThan(
      h.events.indexOf("fork"),
    )
    expect(h.events).not.toContain("archive-local")
    await result.commit!()
    expect(h.events.indexOf("archive-dependency-old")).toBeGreaterThan(
      h.events.indexOf("archive-local"),
    )
    expect(phases).toEqual(["checking", "preparing", "restoring", "switching"])
    const retained = join(
      root,
      "home/sessions/2000/01/01/rollout-2000-01-01T00-00-00-old.jsonl",
    )
    expect(await readFile(retained, "utf8")).toContain("exact history")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("uncertain fork result retains the prepared workspace instead of deleting a possibly live destination", async () => {
  const h = harness()
  h.options.gateways.get("devbox")!.nativeHandoff.forkFromPath = async () => {
    throw new Error("connection lost after request")
  }
  await expect(h.run()).rejects.toThrow("connection lost")
  expect(h.events).not.toContain("cleanup")
  expect(h.events).not.toContain("archive-local")
  expect(
    h.events.some((event) => event.includes("fork could not be confirmed")),
  ).toBe(true)
})

async function treeHarness(
  options: { archivedChild?: boolean; returning?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vimex-native-tree-"))
  const { mkdir } = await import("node:fs/promises")
  const sourceHome = join(root, "source-home"),
    targetHome = join(root, "target-home")
  await mkdir(sourceHome)
  await mkdir(targetHome)
  const h = harness()
  h.options.target = (id) => ({
    id,
    cwd: root,
    executable: "codex",
    mode: "stdio",
  })
  const header = (id: string) =>
    JSON.stringify({
      type: "session_meta",
      payload: { id, history_mode: "paginated" },
    }) + "\n"
  const files = ["old", "child"].map((id) => ({
    id,
    path: join(sourceHome, id + ".jsonl"),
    data: Buffer.from(
      header(id) +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete" },
        }) +
        "\n",
    ),
    complete: true,
    requiredBytes: 0,
  }))
  for (const file of files) file.requiredBytes = file.data.length
  h.options.captureHistory = async () => ({
    files,
    threadId: "old",
    hasSubagents: true,
    verifySourceUnchanged: async () => {},
  })
  const targetPath = (id: string) =>
    join(
      targetHome,
      "sessions/2000/01/01",
      `rollout-2000-01-01T00-00-00-${id}.jsonl`,
    )
  const targetArchived = new Set(options.returning ? ["old", "child"] : [])
  const targetLoaded = new Set<string>()
  if (options.returning) {
    await mkdir(join(targetHome, "sessions/2000/01/01"), { recursive: true })
    for (const file of files)
      await writeFile(targetPath(file.id), header(file.id))
  }
  for (const host of ["local", "devbox"]) {
    const native = h.options.gateways.get(host)!.nativeHandoff
    native.serverDetails = () => ({
      version: "0.166.0",
      codexHome: host === "local" ? sourceHome : targetHome,
    })
    native.inspect = async (id) =>
      ({
        threadId: id,
        historyMode: "paginated",
        status: {
          type:
            host === "local"
              ? "idle"
              : targetLoaded.has(id)
                ? "idle"
                : "notLoaded",
        },
        cwd:
          host === "local" ? root : targetLoaded.has(id) ? "/worktree" : root,
        rolloutPath:
          host === "local" ? join(sourceHome, id + ".jsonl") : targetPath(id),
        parentThreadId: id === "child" ? "old" : null,
        sessionId: "old",
      }) as never
    native.historyDigest = async (id) => "exact-" + id
    native.ownedDescendants = async () =>
      host === "local" || (await Bun.file(targetPath("child")).exists())
        ? ["child"]
        : []
    native.isArchived = async (id) =>
      host === "local"
        ? Boolean(options.archivedChild && id === "child")
        : targetArchived.has(id)
    native.archiveSource = async (id) => {
      h.events.push(`archive-${host}-${id}`)
      if (host === "devbox") {
        targetArchived.add(id)
        targetLoaded.delete(id)
      }
    }
  }
  const target = h.options.gateways.get("devbox")!.nativeHandoff
  target.locate = async (id) =>
    (await Bun.file(targetPath(id)).exists()) ? targetPath(id) : undefined
  target.hydrateHistory = async (id) => {
    if (targetArchived.has(id))
      throw new Error("Cannot hydrate archived thread")
    h.events.push("hydrate-" + id)
  }
  target.unarchiveTree = async (id) => {
    h.events.push("unarchive-" + id)
    targetArchived.clear()
    return targetPath(id)
  }
  target.resumeTree = async (id) => {
    h.events.push("resume-" + id)
    targetLoaded.add(id)
    return { summary: { id } } as never
  }
  return {
    ...h,
    root,
    targetHome,
    targetPath,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

test("subagent trees resume original IDs and restore archived children after source retirement", async () => {
  const h = await treeHarness({ archivedChild: true })
  try {
    const result = await h.run()
    expect(result.threadId).toBe("old")
    expect(h.events).toContain("resume-old")
    expect(h.events).toContain("resume-child")
    expect(h.events).not.toContain("fork")
    expect(h.events).not.toContain("archive-local-old")
    await result.commit!()
    expect(h.events.indexOf("archive-devbox-child")).toBeGreaterThan(
      h.events.indexOf("archive-local-old"),
    )
    expect(h.events).not.toContain("archive-devbox-old")
    await result.rollback!()
    expect(h.events).not.toContain("cleanup")
  } finally {
    await h.dispose()
  }
})

test("returning trees unarchive before refreshing extended native history projections", async () => {
  const h = await treeHarness({ returning: true })
  try {
    const result = await h.run()
    expect(h.events.indexOf("unarchive-old")).toBeLessThan(
      h.events.indexOf("hydrate-old"),
    )
    expect(h.events.indexOf("hydrate-child")).toBeLessThan(
      h.events.indexOf("resume-old"),
    )
    await result.commit!()
    expect(h.events).toContain("archive-local-old")
  } finally {
    await h.dispose()
  }
})

test("extra destination agents reject tree activation before workspace preparation", async () => {
  const h = await treeHarness()
  try {
    h.options.gateways.get("devbox")!.nativeHandoff.ownedDescendants =
      async () => ["unexpected"]
    await expect(h.run()).rejects.toThrow("extra agents")
    expect(h.events).not.toContain("prepare")
    expect(h.events).not.toContain("archive-local-old")
  } finally {
    await h.dispose()
  }
})

test("uncertain tree unarchive retains advanced checkpoints and prepared workspace", async () => {
  const h = await treeHarness({ returning: true })
  try {
    h.options.gateways.get("devbox")!.nativeHandoff.unarchiveTree =
      async () => {
        throw new Error("lost unarchive reply")
      }
    await expect(h.run()).rejects.toThrow("retained")
    expect(h.events).not.toContain("cleanup")
    expect(h.events).not.toContain("archive-local-old")
    expect(await readFile(h.targetPath("old"), "utf8")).toContain(
      "task_complete",
    )
  } finally {
    await h.dispose()
  }
})

test("orphaned destination goal state blocks tree import before activation", async () => {
  const h = await treeHarness()
  try {
    const process = Bun.spawn(
      [
        "python3",
        "-c",
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');c.execute('INSERT INTO thread_goals(thread_id) VALUES (?)',('child',));c.commit();c.close()`,
        join(h.targetHome, "goals_1.sqlite"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await process.exited).toBe(0)
    await expect(h.run()).rejects.toThrow("stored goal state")
    expect(h.events).not.toContain("prepare")
    expect(h.events).not.toContain("resume-old")
    expect(await Bun.file(h.targetPath("child")).exists()).toBe(false)
  } finally {
    await h.dispose()
  }
})

test("historical agents owned by another parent refuse before connecting or preparing", async () => {
  const h = await treeHarness()
  try {
    h.options.gateways.get("local")!.nativeHandoff.ownedDescendants =
      async () => []
    await expect(h.run()).rejects.toThrow("original parent session")
    expect(h.events).not.toContain("connect")
    expect(h.events).not.toContain("prepare")
    expect(h.events).not.toContain("archive-local-old")
  } finally {
    await h.dispose()
  }
})

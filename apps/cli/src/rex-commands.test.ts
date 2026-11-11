import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PaneStateStore } from "@vimex/platform-node"
import { runRexCommand } from "./rex-commands"

const environment = {
  REX_SERVER: "unix:///test.sock",
  REX_SESSION: "session:one",
  REX_BLOCK: "block:one",
}
const identity = {
  server: environment.REX_SERVER,
  session: environment.REX_SESSION,
  block: environment.REX_BLOCK,
}
test("resume-pane does nothing outside a terminal, without a checkpoint, or in another pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-resume-"))
  try {
    const options = {
      write() {},
      environment,
      stateRoot: root,
      terminal: true,
      verify: async () => {
        throw new Error("unexpected Rex initialization")
      },
    }
    expect(
      await runRexCommand({ action: "resume-pane" }, options),
    ).toBeUndefined()
    expect(
      await runRexCommand(
        { action: "resume-pane" },
        { ...options, terminal: false },
      ),
    ).toBeUndefined()
    expect(
      await runRexCommand(
        { action: "resume-pane" },
        { ...options, environment: {} },
      ),
    ).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("resume-pane restores the exact machine/thread/config and never picks another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-resume-"))
  try {
    const store = new PaneStateStore(identity, root)
    const checkpoint = {
      version: 1 as const,
      instanceId: "instance-one",
      active: true,
      target: {
        machine: "devbox",
        thread: "thread-one",
        cwd: "/remote/project",
        localCwd: "/local/project",
        config: "/local/vimex.json",
      },
      machines: {},
    }
    await store.write(checkpoint)
    const verified: unknown[] = []
    const options = {
      write() {},
      environment,
      stateRoot: root,
      terminal: true,
      verify: async (value: unknown) => {
        verified.push(value)
      },
    }
    expect(
      await runRexCommand({ action: "resume-pane" }, options),
    ).toMatchObject({
      machine: "devbox",
      thread: "thread-one",
      cwd: "/local/project",
      remoteCwd: "/remote/project",
      config: "/local/vimex.json",
      restorePane: true,
    })
    expect(verified).toEqual([identity])
    await expect(
      runRexCommand(
        { action: "resume-pane" },
        {
          ...options,
          verify: async () => {
            throw new Error("wrong Rex server")
          },
        },
      ),
    ).rejects.toThrow("wrong Rex server")
    expect(
      await runRexCommand(
        { action: "resume-pane" },
        {
          ...options,
          environment: { ...environment, REX_BLOCK: "block:other" },
        },
      ),
    ).toBeUndefined()
    await store.write({ ...checkpoint, active: false })
    expect(
      await runRexCommand({ action: "resume-pane" }, options),
    ).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("hook generation is headless", async () => {
  const output: string[] = []
  expect(
    await runRexCommand(
      { action: "hook", shell: "zsh" },
      { write: (text) => output.push(text), launcher: ["/my path/vimex"] },
    ),
  ).toBeUndefined()
  expect(output[0]).toContain("'/my path/vimex' rex resume-pane")
})

test("explicit legacy import rejects nonterminals and incomplete identity", async () => {
  const options = { write() {}, environment: {}, terminal: true }
  await expect(
    runRexCommand({ action: "import-state" }, options),
  ).rejects.toThrow("complete Rex pane identity")
  await expect(
    runRexCommand({ action: "import-state" }, { ...options, terminal: false }),
  ).rejects.toThrow("interactive Rex terminal")
})

import { expect, test } from "bun:test"
import { createMachineNavigation } from "./machine-navigation"
import { defaultConfig, type VimexConfig } from "@vimex/platform-node"
import { emptyLocalState } from "@vimex/workbench"
import { createDemoGateway } from "./demo-gateway"

function setup(
  overrides = {},
  saveMachines?: (
    machines: VimexConfig["machines"],
    favoriteMachines: string[],
  ) => Promise<void>,
) {
  const targets: unknown[] = []
  const remote: unknown[] = []
  const result = createMachineNavigation({
    config: { ...defaultConfig, ...overrides },
    saveMachines,
    initialMachine: "local",
    localCwd: "/local/repo",
    createRuntime(target, cwd) {
      targets.push({ target, cwd })
      const demo = createDemoGateway()
      return {
        conversation: demo,
        approvals: demo,
        connection: demo,
        models: { listModels: async () => [] },
      }
    },
    async resolveRemoteDirectory(host, cwd) {
      remote.push({ host, cwd })
      return "/home/dev/work"
    },
    loadState: async () => emptyLocalState(),
  })
  return { ...result, targets, remote }
}
test("local default uses daemon and remote aliases preserve remote paths", async () => {
  const s = setup({
    machines: { devbox: { sshHost: "ubuntu@devbox", cwd: "~/work" } },
  })
  expect((await s.navigation.open("local")).cwd).toBe("/local/repo")
  const remote = await s.navigation.open("devbox")
  expect(remote.cwd).toBe("/home/dev/work")
  expect(s.remote).toEqual([{ host: "ubuntu@devbox", cwd: "~/work" }])
  expect(remote.resolveDirectory!("/home/dev/work", "../other")).toBe(
    "/home/dev/other",
  )
  expect(s.targets[0]).toMatchObject({ target: { mode: "daemon" } })
})
test("explicit executables preserve stdio compatibility and dynamic aliases are validated", async () => {
  const s = setup({ codexExecutable: "/tmp/fixture" })
  await s.navigation.open("local")
  expect(s.targets[0]).toMatchObject({ target: { mode: "stdio" } })
  await s.navigation.open("devbox")
  expect(s.navigation.list()).toContainEqual({ id: "devbox" })
  await expect(s.navigation.open("-bad")).rejects.toThrow("Invalid machine")
})

test("machine management persists stable identities and labels across restart", async () => {
  let saved: VimexConfig["machines"] = {}
  const s = setup({}, async (machines) => {
    saved = structuredClone(machines)
  })
  await s.navigation.add!({ id: "devbox", sshHost: "ubuntu@devbox" })
  await s.navigation.rename!("devbox", "Travel VM")
  expect(saved).toEqual({
    devbox: { sshHost: "ubuntu@devbox", label: "Travel VM" },
  })
  const restarted = setup({ machines: saved })
  expect(restarted.navigation.list()).toContainEqual({
    id: "devbox",
    label: "Travel VM",
  })
  expect((await restarted.navigation.open("devbox")).machine).toEqual({
    id: "devbox",
    label: "Travel VM",
  })
  await s.navigation.remove!("devbox")
  expect(saved).toEqual({})
  expect(s.navigation.list()).toEqual([{ id: "local" }])
})

test("machine mutations validate before saving and recover from persistence failure", async () => {
  let fail = true
  let writes = 0
  const s = setup({}, async () => {
    writes++
    if (fail) throw new Error("disk full")
  })
  await expect(
    s.navigation.add!({ id: "bad", sshHost: "-option" }),
  ).rejects.toThrow("SSH host")
  await expect(
    s.navigation.add!({ id: "local", sshHost: "host" }),
  ).rejects.toThrow("already exists")
  await expect(s.navigation.rename!("local", "Laptop")).rejects.toThrow(
    "local machine",
  )
  await expect(s.navigation.remove!("local")).rejects.toThrow("local machine")
  expect(writes).toBe(0)
  await expect(
    s.navigation.add!({ id: "devbox", sshHost: "host" }),
  ).rejects.toThrow("disk full")
  expect(s.navigation.list()).toEqual([{ id: "local" }])
  fail = false
  await s.navigation.add!({ id: "devbox", sshHost: "host" })
  fail = true
  await expect(s.navigation.rename!("devbox", "Travel")).rejects.toThrow(
    "disk full",
  )
  await expect(s.navigation.remove!("devbox")).rejects.toThrow("disk full")
  expect(s.navigation.list()).toContainEqual({ id: "devbox" })
})

test("concurrent additions preserve each other and transient aliases can be saved or removed", async () => {
  let saved: VimexConfig["machines"] = {}
  const s = setup({}, async (machines) => {
    await Promise.resolve()
    saved = structuredClone(machines)
  })
  await Promise.all([
    s.navigation.add!({ id: "one", sshHost: "first" }),
    s.navigation.add!({ id: "two", sshHost: "second" }),
  ])
  expect(Object.keys(saved)).toEqual(["one", "two"])
  await s.navigation.open("devbox")
  await s.navigation.rename!("devbox", "Travel")
  expect(saved.devbox).toEqual({ sshHost: "devbox", label: "Travel" })
  await s.navigation.open("ephemeral")
  await s.navigation.remove!("ephemeral")
  expect(s.navigation.list().map((machine) => machine.id)).not.toContain(
    "ephemeral",
  )
})

test("management reserves action names and handles object property names as machine IDs", async () => {
  let saved: VimexConfig["machines"] = {}
  const s = setup({}, async (machines) => {
    saved = structuredClone(machines)
  })
  for (const id of ["add", "rename", "remove"])
    await expect(s.navigation.add!({ id, sshHost: "host" })).rejects.toThrow(
      "Reserved machine name",
    )
  await s.navigation.add!({ id: "constructor", sshHost: "host" })
  await s.navigation.rename!("constructor", "Build VM")
  expect(Object.hasOwn(saved, "constructor")).toBe(true)
  expect((await s.navigation.open("constructor")).machine.label).toBe(
    "Build VM",
  )
  await s.navigation.open("toString")
  await s.navigation.rename!("toString", "Other VM")
  expect(Object.entries(saved).find(([id]) => id === "toString")?.[1]).toEqual({
    sshHost: "toString",
    label: "Other VM",
  })
})

test("adding a known SSH alias saves it without rebinding the live connection", async () => {
  let saved: VimexConfig["machines"] = {}
  const s = setup({}, async (machines) => {
    saved = structuredClone(machines)
  })
  await s.navigation.open("devbox")
  await expect(
    s.navigation.add!({ id: "devbox", sshHost: "other-host" }),
  ).rejects.toThrow("Remove connection devbox")
  expect(saved).toEqual({})
  expect(s.target("devbox").sshHost).toBe("devbox")
  await s.navigation.add!({ id: "devbox", sshHost: "devbox" })
  const restarted = setup({ machines: saved })
  expect(restarted.navigation.list()).toContainEqual({ id: "devbox" })
  expect(restarted.target("devbox").sshHost).toBe("devbox")
  await expect(
    s.navigation.add!({ id: "devbox", sshHost: "devbox" }),
  ).rejects.toThrow("already exists")
})

test("favorites persist for local and transient remote machines and removal clears them", async () => {
  let saved = { machines: {}, favoriteMachines: [] } as Pick<
    VimexConfig,
    "machines" | "favoriteMachines"
  >
  const s = setup({}, async (machines, favoriteMachines) => {
    saved = structuredClone({ machines, favoriteMachines })
  })
  await s.navigation.open("devbox")
  await Promise.all([
    s.navigation.setFavorite!("local", true),
    s.navigation.setFavorite!("devbox", true),
  ])
  expect(saved).toEqual({
    machines: { devbox: { sshHost: "devbox" } },
    favoriteMachines: ["local", "devbox"],
  })
  const restarted = setup(saved)
  expect(restarted.navigation.list()).toEqual([
    { id: "local", favorite: true },
    { id: "devbox", favorite: true },
  ])
  expect((await restarted.navigation.open("devbox")).machine.favorite).toBe(
    true,
  )
  await s.navigation.rename!("devbox", "Travel")
  expect(s.navigation.list()).toContainEqual({
    id: "devbox",
    label: "Travel",
    favorite: true,
  })
  await s.navigation.remove!("devbox")
  expect(saved).toEqual({ machines: {}, favoriteMachines: ["local"] })
  await s.navigation.setFavorite!("local", false)
  expect(saved.favoriteMachines).toEqual([])
  expect(s.navigation.current).toEqual({ id: "local" })
})

test("failed favorite saves preserve registry and later writes recover", async () => {
  let fail = true
  const s = setup({}, async () => {
    if (fail) throw new Error("disk full")
  })
  await s.navigation.open("devbox")
  await expect(s.navigation.setFavorite!("devbox", true)).rejects.toThrow(
    "disk full",
  )
  expect(s.navigation.list()).toEqual([{ id: "local" }, { id: "devbox" }])
  fail = false
  await s.navigation.setFavorite!("devbox", true)
  expect(s.navigation.list()).toContainEqual({ id: "devbox", favorite: true })
  fail = true
  await expect(s.navigation.setFavorite!("devbox", false)).rejects.toThrow(
    "disk full",
  )
  await expect(s.navigation.remove!("devbox")).rejects.toThrow("disk full")
  expect(s.navigation.list()).toContainEqual({ id: "devbox", favorite: true })
  await expect(s.navigation.setFavorite!("missing", true)).rejects.toThrow(
    "Unknown machine",
  )
})

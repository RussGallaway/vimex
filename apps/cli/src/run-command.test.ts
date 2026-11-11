import { expect, test } from "bun:test"
import { runCommand, type CommandPorts } from "./run-command"
import { parseCommand } from "./parse-command"

test("help and version never invoke interactive or distribution capabilities", async () => {
  const output: string[] = []
  const unexpected = async () => {
    throw new Error("Unexpected runtime initialization")
  }
  const ports: CommandPorts = {
    version: "0.1.0",
    write: (text) => output.push(text),
    launch: unexpected,
    rex: unexpected,
    doctor: unexpected,
    upgrade: unexpected,
  }
  expect(await runCommand({ kind: "help" }, ports)).toBe(0)
  expect(await runCommand({ kind: "version" }, ports)).toBe(0)
  expect(output[0]).toContain("resume")
  expect(output[1]).toBe("vimex 0.1.0")
})
test("resume dispatch preserves typed intent, and update delegates to the shared upgrader", async () => {
  const launches: unknown[] = [],
    upgrades: unknown[] = []
  const ports: CommandPorts = {
    version: "0.1.0",
    write() {},
    rex: async () => undefined,
    launch: async (options) => {
      launches.push(options)
    },
    doctor: async () => 1,
    upgrade: async (target) => {
      upgrades.push(target)
    },
  }
  await runCommand(parseCommand(["resume", "--last"], "/tmp"), ports)
  expect(launches).toEqual([
    expect.objectContaining({ cwd: "/tmp", resumeMode: "last" }),
  ])
  for (const name of ["update", "upgrade"])
    await runCommand(parseCommand([name, "--version", "0.1.1"]), ports)
  expect(upgrades).toEqual(["0.1.1", "0.1.1"])
  expect(await runCommand({ kind: "doctor" }, ports)).toBe(1)
})

test("Rex dispatch loads the interactive application only for a saved active pane", async () => {
  const launches: unknown[] = []
  const options = {
    cwd: "/project",
    thread: "exact-thread",
    demo: false,
    help: false,
    version: false,
    restorePane: true,
  }
  const ports: CommandPorts = {
    version: "test",
    write() {},
    launch: async (value) => {
      launches.push(value)
    },
    doctor: async () => {},
    upgrade: async () => {},
    rex: async () => undefined,
  }
  await runCommand(parseCommand(["rex", "resume-pane"]), ports)
  expect(launches).toEqual([])
  ports.rex = async () => options
  await runCommand(parseCommand(["rex", "resume-pane"]), ports)
  expect(launches).toEqual([options])
})

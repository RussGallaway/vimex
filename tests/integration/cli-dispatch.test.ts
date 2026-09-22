import { expect, test } from "bun:test"
import { parseCommand } from "../../apps/cli/src/parse-command"
import { runCommand, type CommandPorts } from "../../apps/cli/src/run-command"
import type { CliOptions } from "../../apps/tui/src/cli-options"

function harness() {
  const launches: CliOptions[] = [],
    upgrades: (string | undefined)[] = [],
    output: string[] = []
  let diagnoses = 0
  const ports: CommandPorts = {
    version: "0.1.0",
    write: (line) => {
      output.push(line)
    },
    launch: async (options) => {
      launches.push(options)
    },
    doctor: async () => {
      diagnoses++
      return 0
    },
    upgrade: async (version) => {
      upgrades.push(version)
      return 0
    },
  }
  return { ports, launches, upgrades, output, diagnoses: () => diagnoses }
}

test("update and upgrade dispatch through the exact same injected upgrade capability", async () => {
  const h = harness()
  for (const name of ["update", "upgrade"]) {
    expect(await runCommand(parseCommand([name], "/workspace"), h.ports)).toBe(
      0,
    )
    expect(
      await runCommand(
        parseCommand([name, "--version", "v0.2.0"], "/workspace"),
        h.ports,
      ),
    ).toBe(0)
  }
  expect(h.upgrades).toEqual([undefined, "v0.2.0", undefined, "v0.2.0"])
  expect(h.launches).toEqual([])
  expect(h.diagnoses()).toBe(0)
})

test("help/version/doctor dispatch never call interactive launch", async () => {
  const h = harness()
  for (const args of [["--help"], ["--version"], ["doctor"]])
    await runCommand(parseCommand(args, "/workspace"), h.ports)
  expect(h.launches).toEqual([])
  expect(h.upgrades).toEqual([])
  expect(h.diagnoses()).toBe(1)
  expect(h.output).toContain("vimex 0.1.0")
})

test("resume explicitly selects existing-thread modes and never turns trailing input into a prompt", async () => {
  const h = harness()
  for (const args of [
    ["resume", "thread-123"],
    ["resume"],
    ["resume", "--last"],
  ]) {
    await runCommand(parseCommand(args, "/workspace"), h.ports)
  }
  expect(h.launches).toMatchObject([
    { cwd: "/workspace", thread: "thread-123", demo: false },
    { cwd: "/workspace", resumeMode: "picker", demo: false },
    { cwd: "/workspace", resumeMode: "last", demo: false },
  ])
  expect(() =>
    parseCommand(["resume", "thread-123", "accidental prompt"], "/workspace"),
  ).toThrow()
  expect(() =>
    parseCommand(["resume", "thread-123", "--last"], "/workspace"),
  ).toThrow()
  expect(() => parseCommand(["resume", "--demo"], "/workspace")).toThrow()
  expect(h.upgrades).toEqual([])
})

test("headless capability errors propagate without falling back to interactive launch", async () => {
  const h = harness()
  h.ports.upgrade = async () => {
    throw new Error("checksum rejected")
  }
  await expect(runCommand(parseCommand(["update"]), h.ports)).rejects.toThrow(
    "checksum rejected",
  )
  h.ports.doctor = async () => 1
  expect(await runCommand(parseCommand(["doctor"]), h.ports)).toBe(1)
  expect(h.launches).toEqual([])
})

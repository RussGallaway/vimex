import { expect, test } from "bun:test"
import { parseCommand } from "./parse-command"

test("CLI separates paths, explicit sessions, cwd picker, and most recent resume", () => {
  expect(parseCommand(["my project", "--model", "sol"], "/tmp")).toEqual({
    kind: "launch",
    options: {
      cwd: "/tmp/my project",
      model: "sol",
      demo: false,
      help: false,
      version: false,
    },
  })
  expect(parseCommand(["resume", "thread-id"], "/tmp")).toMatchObject({
    kind: "launch",
    options: { cwd: "/tmp", thread: "thread-id" },
  })
  expect(parseCommand(["resume"], "/tmp")).toMatchObject({
    options: { resumeMode: "picker" },
  })
  expect(
    parseCommand(["resume", "--last", "--cwd", "project"], "/tmp"),
  ).toMatchObject({ options: { cwd: "/tmp/project", resumeMode: "last" } })
  expect(
    parseCommand(["--thread", "legacy", "--config", "settings.json"], "/tmp"),
  ).toMatchObject({
    options: { thread: "legacy", config: "/tmp/settings.json" },
  })
  expect(parseCommand(["--", "-project"], "/tmp")).toMatchObject({
    options: { cwd: "/tmp/-project" },
  })
})
test("CLI aliases upgrades, parses doctor config, and rejects conflicting targets", () => {
  expect(parseCommand(["update", "--version", "0.1.0"])).toEqual(
    parseCommand(["upgrade", "--version", "0.1.0"]),
  )
  expect(parseCommand(["doctor", "--config", "config.json"], "/tmp")).toEqual({
    kind: "doctor",
    config: "/tmp/config.json",
  })
  for (const args of [
    ["resume", "id", "--last"],
    ["resume", "--demo"],
    ["path", "--cwd", "other"],
    ["--last"],
    ["--cwd", "-hmm"],
    ["upgrade", "unexpected"],
  ])
    expect(() => parseCommand(args)).toThrow()
})

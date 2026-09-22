import { expect, test } from "bun:test"
import { parseGoalCommand } from "./goal-command"
import { commandCompletions } from "./command-line"
import { parseCommand, validateCommand } from "./parser"

test("goal syntax keeps literal objectives and requires explicit positive budgets", () => {
  expect(parseGoalCommand("")).toEqual({ kind: "show" })
  expect(parseGoalCommand("Fix the parser and tests")).toEqual({
    kind: "set",
    objective: "Fix the parser and tests",
  })
  expect(parseGoalCommand("set pause")).toEqual({
    kind: "set",
    objective: "pause",
  })
  expect(parseGoalCommand("--budget 12000 Fix tests")).toEqual({
    kind: "set",
    objective: "Fix tests",
    tokenBudget: 12000,
  })
  for (const value of [
    "--budget 0 fix",
    "--budget -1 fix",
    "--budget 1.5 fix",
    "--budget 10",
    "--budget 99999999999999999 fix",
    "set",
    "x".repeat(4001),
  ])
    expect(parseGoalCommand(value).kind).toBe("invalid")
  expect(parseGoalCommand("😀".repeat(4000)).kind).toBe("set")
  expect(parseGoalCommand("pause")).toEqual({
    kind: "status",
    status: "paused",
  })
  expect(parseGoalCommand("resume")).toEqual({
    kind: "status",
    status: "active",
  })
})

test("goal completes command/subcommands and validates before execution", () => {
  expect(commandCompletions("go")).toContain(":goal")
  expect(commandCompletions("goal re")).toEqual([":goal resume"])
  const command = parseCommand(":goal --budget 0 objective")
  expect(command.kind).toBe("command")
  if (command.kind === "command")
    expect(validateCommand(command)).toContain("positive token count")
})

import { test, expect } from "bun:test"
import { parseCommand, validateCommand } from "./parser"

test("Ex aliases resolve to typed application commands", () => {
  expect(parseCommand(":q")).toEqual({
    kind: "command",
    name: "quit",
    argument: "",
  })
  expect(parseCommand("models test")).toEqual({
    kind: "command",
    name: "model",
    argument: "test",
  })
  expect(parseCommand(":perf export")).toEqual({
    kind: "command",
    name: "performance",
    argument: "export",
  })
})
test("Ex arguments preserve paths and distinguish empty or unknown commands", () => {
  expect(parseCommand(":cwd /tmp/project with  spaces")).toEqual({
    kind: "command",
    name: "cwd",
    argument: "/tmp/project with  spaces",
  })
  expect(parseCommand(":   ")).toEqual({ kind: "empty" })
  expect(parseCommand(":missing value")).toEqual({
    kind: "unknown",
    name: "missing",
  })
})

test("every no-argument command rejects trailing arguments with its documented usage", () => {
  for (const name of [
    "compact",
    "quit",
    "approvals",
    "approve",
    "reject",
    "stop",
    "fork",
    "fold",
    "unfold",
    "questions",
    "agents",
    "parent",
    "restart",
    "insert",
    "normal",
    "visual",
    "follow",
  ]) {
    const parsed = parseCommand(`:${name} accidental`)
    if (parsed.kind !== "command") throw new Error(`Missing command ${name}`)
    expect(validateCommand(parsed)).toBe(`Usage: :${name}`)
  }
})

test("validation preserves literal arguments but rejects invalid enumerated arguments", () => {
  const valid = [
    ":cwd /tmp/path with  spaces",
    ":new /tmp/another project",
    ":sessions exact-thread-id",
    ":rename A title: with / punctuation",
    ":open https://example.test/a?b=c#d",
    ":help model",
    ":help q",
    ":favorite",
    ":favorite on",
    ":favorite off",
    ":follow",
    ":submit",
    ":submit queue",
    ":submit steer",
    ":syntax theme",
    ":yank markdown",
    ":performance export",
    ":perf export",
  ]
  for (const line of valid) {
    const parsed = parseCommand(line)
    if (parsed.kind !== "command") throw new Error(line)
    expect(validateCommand(parsed)).toBeUndefined()
  }
  for (const line of [
    ":rename",
    ":submit surprise",
    ":yank raw",
    ":favorite yes",
    ":theme nord extra",
    ":thinking high extra",
    ":model model high extra",
    ":help nonexistent",
    ":performance",
    ":perf",
    ":performance start",
    ":perf export extra",
  ]) {
    const parsed = parseCommand(line)
    if (parsed.kind !== "command") throw new Error(line)
    expect(validateCommand(parsed)).toStartWith("Usage: :")
  }
})

test("dynamic model and reasoning validation uses the supplied catalog only", () => {
  const options = {
    models: ["fast", "deep"],
    modelEfforts: { fast: ["low"], deep: ["high"] },
    currentModel: "fast",
  }
  for (const [line, valid] of [
    [":model deep high", true],
    [":model fast high", false],
    [":model missing", false],
    [":thinking low", true],
    [":thinking high", false],
  ] as const) {
    const parsed = parseCommand(line)
    if (parsed.kind !== "command") throw new Error(line)
    expect(validateCommand(parsed, options) === undefined).toBe(valid)
  }
  const parsed = parseCommand(":model server-known custom")
  if (parsed.kind !== "command") throw new Error("Expected command")
  expect(validateCommand(parsed)).toBeUndefined()
})

test("side commands preserve free-form questions and expose their lifecycle actions", () => {
  for (const argument of [
    "",
    "close",
    "quit",
    "refresh",
    "maximize",
    "focus parent",
    "focus side",
    "Why did we choose this?",
    "Explain /tmp/path with  spaces",
  ]) {
    const parsed = parseCommand(`:side ${argument}`)
    expect(parsed).toEqual({ kind: "command", name: "side", argument })
    if (parsed.kind !== "command") throw new Error("Expected side command")
    expect(validateCommand(parsed)).toBeUndefined()
  }
})

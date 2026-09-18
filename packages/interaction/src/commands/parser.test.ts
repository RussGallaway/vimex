import { test, expect } from "bun:test"
import { parseCommand } from "./parser"

test("Ex aliases resolve to typed application commands", () => {
  expect(parseCommand(":q")).toEqual({ kind: "command", name: "quit", argument: "" })
  expect(parseCommand("models test")).toEqual({ kind: "command", name: "model", argument: "test" })
})
test("Ex arguments preserve paths and distinguish empty or unknown commands", () => {
  expect(parseCommand(":cwd /tmp/project with  spaces")).toEqual({ kind: "command", name: "cwd", argument: "/tmp/project with  spaces" })
  expect(parseCommand(":   ")).toEqual({ kind: "empty" })
  expect(parseCommand(":missing value")).toEqual({ kind: "unknown", name: "missing" })
})

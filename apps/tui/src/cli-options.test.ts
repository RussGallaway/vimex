import { test, expect } from "bun:test"
import { parseCliOptions } from "./cli-options"
test("CLI arguments preserve spaces and resolve only path values", () => {
  expect(
    parseCliOptions(
      ["--cwd", "a b", "--thread", "thread-id", "--model", "model", "--demo"],
      "/tmp",
    ),
  ).toEqual({
    cwd: "/tmp/a b",
    thread: "thread-id",
    model: "model",
    demo: true,
    help: false,
    version: false,
  })
})
test("CLI rejects ambiguous or missing options", () => {
  expect(() => parseCliOptions(["--thread"])).toThrow("requires a value")
  expect(() => parseCliOptions(["--thread", "--demo"])).toThrow(
    "requires a value",
  )
  expect(() => parseCliOptions(["--surprise"])).toThrow("Unknown argument")
})

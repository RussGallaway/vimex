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

test("remote cwd stays remote regardless of argument order", () => {
  for (const args of [
    ["--machine", "devbox", "--cwd", "~/work"],
    ["--cwd", "~/work", "--machine", "devbox"],
  ]) {
    expect(parseCliOptions(args, "/laptop")).toMatchObject({
      machine: "devbox",
      remoteCwd: "~/work",
    })
  }
  expect(() => parseCliOptions(["--machine", "../host"])).toThrow()
  expect(() => parseCliOptions(["--machine", "devbox", "--demo"])).toThrow()
})

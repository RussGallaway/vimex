import { test, expect } from "bun:test"
import { commandCompletions, initialCommandHistory, recallCommand, recordCommand } from "./command-line"

test("history recalls commands and restores unfinished input on moving forward", () => {
  let state = recordCommand(recordCommand(initialCommandHistory(), ":model test"), "sessions")
  let result = recallCommand(state, "unfinished", -1)
  expect(result.value).toBe("sessions")
  result = recallCommand(result.history, result.value, -1)
  expect(result.value).toBe("model test")
  result = recallCommand(result.history, result.value, 1)
  result = recallCommand(result.history, result.value, 1)
  expect(result.value).toBe("unfinished")
  expect(recordCommand(state, "sessions").entries).toEqual(["model test", "sessions"])
})
test("completion uses the shared command vocabulary and argument choices", () => {
  expect(commandCompletions(":rest")).toEqual([":restart"])
  expect(commandCompletions(":yank m")).toEqual([":yank markdown"])
  expect(commandCompletions(":not-real")).toEqual([])
})

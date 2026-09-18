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
  expect(commandCompletions(":model sol-5.6 ", {
    models: ["sol-5.6"], modelEfforts: { "sol-5.6": ["low", "medium", "high"] },
  })).toEqual([":model sol-5.6 low", ":model sol-5.6 medium", ":model sol-5.6 high"])
  expect(commandCompletions(":model sol-5.6 m", {
    models: ["sol-5.6"], modelEfforts: { "sol-5.6": ["low", "medium", "high"] },
  })).toEqual([":model sol-5.6 medium"])
})


test("completes thinking from the active model and shared static choices", () => {
  const options = { models: ["fast", "deep"], modelEfforts: { fast: ["low", "medium"], deep: ["high"] }, currentModel: "fast" }
  expect(commandCompletions(":thinking ", options)).toEqual([":thinking low", ":thinking medium"])
  expect(commandCompletions(":thinking h", options)).toEqual([])
  expect(commandCompletions(":thinking ", { ...options, currentModel: "deep" })).toEqual([":thinking high"])
  expect(commandCompletions(":syntax t")).toEqual([":syntax theme", ":syntax tokyo-night"])
  expect(commandCompletions(":submit ")).toEqual([":submit queue", ":submit steer"])
  expect(commandCompletions(":favorite o")).toEqual([":favorite on", ":favorite off"])
  expect(commandCompletions(":help fol")).toEqual([":help fold", ":help follow"])
  expect(commandCompletions(":models fast m", options)).toEqual([":models fast medium"])
  expect(commandCompletions(":model\tfast\tm", options)).toEqual([":model fast medium"])
})

test("completion does not rewrite literal arguments or silently discard extra tokens", () => {
  for (const value of [":cwd /tmp/project with spaces", ":rename a title", ":open https://example.test", ":yank text extra", ":model fast high extra", ":submit queue extra", ":follow "]) expect(commandCompletions(value)).toEqual([])
})


test("session completion suggests known exact IDs without constraining literal resume", () => {
  expect(commandCompletions(":sessions abc", { sessionIds: ["abc-123", "abc-456", "other-789"] })).toEqual([":sessions abc-123", ":sessions abc-456"])
  expect(commandCompletions(":sessions unknown", { sessionIds: ["abc-123"] })).toEqual([])
})

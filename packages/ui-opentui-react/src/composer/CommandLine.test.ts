import { describe, expect, test } from "bun:test"
import { commandBody, commandPrompt } from "./CommandLine"

describe("command line presentation", () => {
  test("uses the search direction as its prompt without a duplicated colon", () => {
    expect(commandPrompt(":theme nord")).toBe(":")
    expect(commandBody(":theme nord")).toBe("theme nord")
    expect(commandPrompt("/needle")).toBe("/")
    expect(commandBody("/needle")).toBe("needle")
    expect(commandPrompt("?previous")).toBe("?")
    expect(commandBody("?previous")).toBe("previous")
  })
})

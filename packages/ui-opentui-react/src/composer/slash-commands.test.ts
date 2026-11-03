import { expect, test } from "bun:test"
import { parseCommand, validateCommand } from "@vimex/interaction"
import { slashCommandChoices } from "./slash-commands"

test("machine modal and management share slash and Ex command vocabulary", () => {
  expect(slashCommandChoices("/mach")).toEqual(["machine"])
  for (const body of [
    "machine",
    "machine devbox",
    "machine add travel devbox",
    "machine rename travel Travel VM",
    "machine favorite local",
    "machine remove travel",
    "handoff devbox",
  ]) {
    expect(slashCommandChoices(`/${body}`)).toEqual([body])
    const parsed = parseCommand(body)
    expect(parsed).toEqual(parseCommand(`:${body}`))
    expect(parsed.kind).toBe("command")
    if (parsed.kind === "command")
      expect(validateCommand(parsed)).toBeUndefined()
  }
})

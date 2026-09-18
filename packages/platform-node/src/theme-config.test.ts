import { expect, test } from "bun:test"
import { themeNames, commandCompletions, parseCommand, validateCommand } from "@vimex/interaction"
import { parseConfig } from "./config"

for (const theme of themeNames) test(`${theme} is accepted consistently by configuration and command completion`, () => {
  expect(parseConfig({ theme, syntaxTheme: theme })).toMatchObject({ theme, syntaxTheme: theme })
  expect(commandCompletions(":theme ")).toContain(`:theme ${theme}`)
  expect(commandCompletions(":syntax ")).toContain(`:syntax ${theme}`)
  const command = parseCommand(`theme ${theme}`)
  expect(command.kind).toBe("command")
  if (command.kind === "command") expect(validateCommand(command)).toBeUndefined()
})

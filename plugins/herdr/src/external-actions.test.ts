import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHerdrExternalActions, readExternalActionConfig } from "./external-actions"

test("uses the platform fallback when no Herdr URL command is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-herdr-"))
  const opened: string[] = []
  const actions = createHerdrExternalActions({ configDir: directory, fallbackOpenUrl: async url => { opened.push(url) } })
  await actions.openUrl("https://opentui.com")
  expect(opened).toEqual(["https://opentui.com/"])
})

test("runs a configured argv command with URL substitution and no shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-herdr-"))
  await writeFile(join(directory, "external-actions.json"), JSON.stringify({
    openUrl: { command: ["url-dispatch", "--target", "{url}"] },
  }))
  const calls: Array<[string, readonly string[]]> = []
  const actions = createHerdrExternalActions({
    configDir: directory,
    fallbackOpenUrl: async () => { throw new Error("unexpected fallback") },
    run: async (command, args) => { calls.push([command, args]) },
  })
  await actions.openUrl("https://example.com/a?b=1")
  expect(calls).toEqual([["url-dispatch", ["--target", "https://example.com/a?b=1"]]])
})

test("rejects unsupported protocols and malformed configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vimex-herdr-"))
  const actions = createHerdrExternalActions({ configDir: directory, fallbackOpenUrl: async () => {} })
  await expect(actions.openUrl("file:///tmp/secret")).rejects.toThrow("Unsupported URL protocol")
  await writeFile(join(directory, "external-actions.json"), JSON.stringify({ openUrl: { command: [] } }))
  await expect(readExternalActionConfig(directory)).rejects.toThrow("non-empty argv")
})

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeSitterClient } from "@opentui/core"
import { vimexSyntaxParsers } from "./register-parsers"

test("vendored parser descriptors contain only local existing assets", () => {
  expect(vimexSyntaxParsers.map(parser => parser.filetype)).toEqual(["python", "bash", "json"])
  for (const parser of vimexSyntaxParsers) {
    expect(parser.wasm).not.toMatch(/^https?:/)
    expect(existsSync(parser.wasm)).toBe(true)
    for (const query of parser.queries.highlights) {
      expect(query).not.toMatch(/^https?:/)
      expect(existsSync(query)).toBe(true)
    }
  }
})

test("vendored parsers produce real highlights offline, including aliases", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vimex-parser-test-"))
  const client = new TreeSitterClient({ dataPath })
  try {
    await client.initialize()
    for (const parser of vimexSyntaxParsers) client.addFiletypeParser(parser)
    const cases = [
      { filetype: "py", source: "def greet(name):\n    return f'hi {name}'", groups: ["keyword", "function", "string"] },
      { filetype: "shell", source: "if test -n \"$HOME\"; then echo ok; fi", groups: ["keyword", "function", "string"] },
      { filetype: "json", source: "{\"count\": 3, \"ready\": true}", groups: ["string.special.key", "number", "constant.builtin"] },
    ]
    for (const example of cases) {
      const result = await client.highlightOnce(example.source, example.filetype)
      expect(result.error).toBeUndefined()
      expect(result.warning).toBeUndefined()
      const captures = new Set(result.highlights?.map(([, , group]) => group))
      for (const group of example.groups) expect(captures.has(group)).toBe(true)
    }
  } finally {
    await client.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
})

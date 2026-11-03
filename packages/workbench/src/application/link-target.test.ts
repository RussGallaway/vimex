import { expect, test } from "bun:test"
import { linkTarget } from "./link-target"

test("file targets preserve host ownership and parse encoded paths and line locations", () => {
  expect(linkTarget("../src/app.ts:42:3")).toEqual({
    kind: "file",
    path: "../src/app.ts",
    line: 42,
  })
  expect(linkTarget("/work/My%20Project/app.ts#L12-L18")).toEqual({
    kind: "file",
    path: "/work/My Project/app.ts",
    line: 12,
  })
  expect(linkTarget("file:///work/a%23b.ts#L9")).toEqual({
    kind: "file",
    path: "/work/a#b.ts",
    line: 9,
  })
  expect(linkTarget("app.ts:123")).toEqual({
    kind: "file",
    path: "app.ts",
    line: 123,
  })
  expect(linkTarget("README.md")).toEqual({ kind: "file", path: "README.md" })
  expect(linkTarget("https://example.com/a?q=1#section")).toEqual({
    kind: "web",
    url: "https://example.com/a?q=1#section",
  })
})

test("file links refuse foreign authorities, unsupported protocols and invalid locations", () => {
  for (const value of [
    "file://devbox/work/a",
    "javascript:alert(1)",
    "javascript:123",
    "mailto:me@example.com",
    "//host/path",
    "a.ts:0",
    "a.ts#section",
    "a%00b.ts",
    "a.ts#L999999999999999999",
    "~/a.ts",
  ])
    expect(() => linkTarget(value)).toThrow()
})

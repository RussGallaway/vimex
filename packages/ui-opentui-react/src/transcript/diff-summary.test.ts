import { expect, test } from "bun:test"
import { diffFiletype, diffSummary } from "./diff-summary"

test("counts only unified hunk additions/removals and excludes headers", () => {
  expect(
    diffSummary(
      "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n---source\n+++source\n same\n\\ No newline at end of file\n--- a/next\n+++ b/next\n@@ -0,0 +1 @@\n+new\n",
    ),
  ).toEqual({ added: 2, removed: 1 })
  expect(diffSummary("+unstructured output\n-no hunk")).toBeUndefined()
  expect(diffSummary("@@ -1 +1 @@\n same\n")).toEqual({ added: 0, removed: 0 })
})

test("maps file extensions to native parser names and leaves unsupported files plain", () => {
  expect(diffFiletype("src/component.tsx")).toBe("typescriptreact")
  expect(diffFiletype("src/app.MTS")).toBe("typescript")
  expect(diffFiletype("ui/view.jsx")).toBe("javascriptreact")
  expect(diffFiletype("app.cjs")).toBe("javascript")
  expect(diffFiletype("docs/readme.md")).toBe("markdown")
  expect(diffFiletype("build.zig")).toBe("zig")
  expect(diffFiletype("scripts/release.py")).toBe("python")
  expect(diffFiletype("scripts/check.sh")).toBe("bash")
  expect(diffFiletype("package.json")).toBe("json")
  expect(diffFiletype("settings.jsonc")).toBe("text")
  expect(diffFiletype("folder.ts/unknown.bin")).toBe("text")
})

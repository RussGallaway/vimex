import { expect, test } from "bun:test"
import { formatPickerPath } from "./picker-path"

test("keeps the start of an unfiltered path and truncates its tail", () => {
  const result = formatPickerPath(
    "/Users/russgallaway/CodeInbox/vimex/packages/ui-opentui-react",
    20,
  )

  expect(result).toStartWith("/Users/russgallaway")
  expect(result).toEndWith("…")
  expect(Bun.stringWidth(result)).toBeLessThanOrEqual(20)
})

test("keeps the filename side of a filtered path and truncates its head", () => {
  const result = formatPickerPath(
    "/Users/russgallaway/CodeInbox/vimex/packages/ui-opentui-react/src/composer/session.ts",
    24,
    "session",
  )

  expect(result).toStartWith("…")
  expect(result).toEndWith("/composer/session.ts")
  expect(Bun.stringWidth(result)).toBeLessThanOrEqual(24)
})

test("treats whitespace-only queries like an unfiltered picker", () => {
  const result = formatPickerPath(
    "/workspace/src/components/Button.tsx",
    16,
    "   ",
  )

  expect(result).toStartWith("/workspace/src/")
  expect(result).toEndWith("…")
})

test("does not split wide or combining graphemes", () => {
  const path = "/workspace/界/👩‍💻/cafe\u0301.ts"
  const result = formatPickerPath(path, 12, "cafe")

  expect(result).toStartWith("…")
  expect(result).toEndWith("cafe\u0301.ts")
  expect(result).not.toContain("\uFFFD")
  expect(Bun.stringWidth(result)).toBeLessThanOrEqual(12)
})

test("handles zero and one-cell widths", () => {
  expect(formatPickerPath("/workspace/file.ts", 0)).toBe("")
  expect(formatPickerPath("/workspace/file.ts", 1)).toBe("…")
})

import { test, expect } from "bun:test"
import { urlCommand } from "./url-opener"
test("URL launch uses discrete arguments without shell interpolation", () => {
  const target = "https://example.com/?q=$(touch+owned)&x=1"
  expect(urlCommand(target, "darwin")).toEqual({
    executable: "open",
    args: [target],
  })
  expect(urlCommand(target, "linux").executable).toBe("xdg-open")
  expect(() => urlCommand("javascript:alert(1)")).toThrow(
    "Unsupported URL protocol",
  )
  expect(() => urlCommand("file:///etc/passwd")).toThrow(
    "Unsupported URL protocol",
  )
})

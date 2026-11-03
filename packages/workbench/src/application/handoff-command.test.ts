import { expect, test } from "bun:test"
import { parseHandoffArgument } from "./handoff-command"
test("handoff accepts machine, isolated, and literal or quoted destination paths", () => {
  expect(parseHandoffArgument("devbox")).toEqual({
    targetId: "devbox",
    isolated: false,
  })
  expect(parseHandoffArgument("local --isolated")).toEqual({
    targetId: "local",
    isolated: true,
  })
  for (const path of [
    "/ready worktree",
    "'/ready worktree'",
    '"/ready worktree"',
  ])
    expect(parseHandoffArgument(`local --cwd ${path}`).destinationCwd).toBe(
      "/ready worktree",
    )
  for (const bad of [
    "",
    "-host",
    "devbox --what",
    "devbox --cwd",
    'devbox --cwd "unterminated',
    "devbox --cwd /line\nnext",
  ])
    expect(() => parseHandoffArgument(bad)).toThrow()
})

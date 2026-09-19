import { expect, test } from "bun:test"
import { commandTitle, displayCommand } from "./command-presentation"
import { mapThreadItem } from "./map-item"
import type { ThreadItem } from "../generated/v0_154_0/v2/ThreadItem"

test("uses command action metadata without hiding mixed unknown operations", () => {
  expect(commandTitle("raw", [{ type: "read", command: "cat README.md", name: "README.md", path: "/repo/README.md" }])).toBe("Read /repo/README.md")
  expect(commandTitle("raw", [{ type: "listFiles", command: "ls", path: "/repo" }])).toBe("List files · /repo")
  expect(commandTitle("raw", [{ type: "search", command: "rg needle", query: "needle", path: "src" }])).toBe("Search · needle · src")
  expect(commandTitle("raw", [{ type: "read", command: "cat a", name: "a", path: "a" }, { type: "unknown", command: "rm b" }])).toBe("Read a · rm b")
})

test("conservatively unwraps literal shell commands and retains ambiguous syntax", () => {
  expect(displayCommand("/bin/zsh -lc 'git status --short'")).toBe("git status --short")
  expect(displayCommand('bash -c "pwd"')).toBe("pwd")
  for (const command of ['bash -c "$HOME"', "zsh -lc 'echo '\\''quoted'", "sh -c 'pwd' && other", "env zsh -lc 'pwd'"]) expect(displayCommand(command)).toBe(command)
})

test("command item separates readable title, exact execution, and unmodified output", () => {
  const command = "/bin/zsh -lc 'cat README.md'"
  const item: Extract<ThreadItem, { type: "commandExecution" }> = {
    type: "commandExecution", id: "command", pluginId: null, scriptPath: null, command, cwd: "/repo", processId: null, source: "agent", status: "completed",
    commandActions: [{ type: "read", command: "cat README.md", name: "README.md", path: "/repo/README.md" }],
    aggregatedOutput: "line one\nline two\n", exitCode: 0, durationMs: 12,
  }
  expect(mapThreadItem(item, "turn", true)).toMatchObject({
    kind: "command", title: "Read /repo/README.md", executionCommand: command,
    detail: "line one\nline two\n", status: "complete", durationMs: 12, activity: { family: "read" },
  })
})

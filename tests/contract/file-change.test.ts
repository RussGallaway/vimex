import { expect, test } from "bun:test"
import { mapThreadItem } from "../../packages/codex-app-server/src/mapping/map-item"

test("file changes preserve exact per-file patches, action and rename metadata", () => {
  const changes = [
    { path: "old.ts", kind: { type: "update" as const, move_path: "new.ts" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
    { path: "gone.ts", kind: { type: "delete" as const }, diff: "@@ -1 +0,0 @@\n-removed\n" },
    { path: "new.py", kind: { type: "add" as const }, diff: "@@ -0,0 +1 @@\n+added\n" },
  ]
  const mapped = mapThreadItem({ id: "edit", type: "fileChange", status: "completed", changes }, "turn", true)
  expect(mapped).toMatchObject({ kind: "edit", patch: changes.map(change => change.diff).join("\n"), changes: [
    { path: "old.ts", action: "update", movePath: "new.ts", patch: changes[0]!.diff },
    { path: "gone.ts", action: "delete", patch: changes[1]!.diff },
    { path: "new.py", action: "add", patch: changes[2]!.diff },
  ] })
})

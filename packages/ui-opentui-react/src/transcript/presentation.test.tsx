import { test, expect } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { DiffRenderable } from "@opentui/core"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { FileChange } from "./FileChange"
import { ToolCall } from "./ToolCall"
import { createEmberTideSyntax } from "../theme"

test("file edits choose split or unified presentation from real terminal width", async () => {
  for (const [width, expected] of [
    [80, "unified"],
    [140, "split"],
  ] as const) {
    const syntax = createEmberTideSyntax()
    const setup = await testRender(
      <FileChange
        folded={false}
        syntax={syntax}
        item={{
          id: itemId("edit"),
          turnId: turnId("turn"),
          kind: "edit",
          title: "sample.ts",
          status: "complete",
          patch:
            "--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1 @@\n-const n = 1\n+const n = 2\n",
        }}
      />,
      { width, height: 12 },
    )
    try {
      await act(async () => setup.flush())
      const diff = setup.renderer.root.findDescendantById(
        "diff:edit",
      ) as DiffRenderable
      expect(diff.view).toBe(expected)
      expect(setup.captureCharFrame()).toContain("const n = 2")
    } finally {
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    }
  }
})

test("tool cards expose duration alongside output", async () => {
  const setup = await testRender(
    <ToolCall
      folded={false}
      item={{
        id: itemId("command"),
        turnId: turnId("turn"),
        kind: "command",
        title: "run tests",
        detail: "All checks passed",
        status: "complete",
        durationMs: 1250,
      }}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => setup.flush())
    const frame = setup.captureCharFrame()
    expect(frame).toContain("1.3s")
    expect(frame).toContain("All checks passed")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

test("multiple file changes render independent exact patches, paths, actions, and summaries", async () => {
  const changes = [
    {
      path: "old.ts",
      action: "update" as const,
      movePath: "new.ts",
      patch: "--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-oldValue\n+newValue\n",
    },
    {
      path: "added.py",
      action: "add" as const,
      patch: "--- /dev/null\n+++ b/added.py\n@@ -0,0 +1 @@\n+addedValue\n",
    },
  ]
  for (const width of [80, 140]) {
    const syntax = createEmberTideSyntax()
    const setup = await testRender(
      <FileChange
        folded={false}
        syntax={syntax}
        item={{
          id: itemId("multi"),
          turnId: turnId("turn"),
          kind: "edit",
          title: "old.ts, added.py",
          status: "complete",
          changes,
          patch: changes.map((change) => change.patch).join("\n"),
        }}
      />,
      { width, height: 24 },
    )
    try {
      await act(async () => setup.flush())
      const frame = setup.captureCharFrame()
      expect(frame).toContain("▾")
      expect(frame).toContain("2 files changed")
      expect(frame).toContain("old.ts → new.ts")
      expect(frame).toContain("rename")
      expect(frame).toContain("+2 −1")
      expect(frame).toContain("newValue")
      expect(frame).toContain("addedValue")
      for (const [index, change] of changes.entries())
        expect(
          (
            setup.renderer.root.findDescendantById(
              index === 0 ? "diff:multi" : `diff:multi:${index}`,
            ) as DiffRenderable
          ).diff,
        ).toBe(change.patch)
    } finally {
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    }
  }
})

test("collapsed edits use disclosure headers and do not instantiate diff bodies", async () => {
  const syntax = createEmberTideSyntax()
  const setup = await testRender(
    <FileChange
      folded
      syntax={syntax}
      item={{
        id: itemId("fold"),
        turnId: turnId("turn"),
        kind: "edit",
        title: "sample.ts",
        status: "complete",
        patch: "@@ -1 +1 @@\n-old\n+new",
      }}
    />,
    { width: 60, height: 10 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("▸")
    expect(setup.captureCharFrame()).not.toContain("[closed]")
    expect(setup.renderer.root.findDescendantById("diff:fold")).toBeUndefined()
  } finally {
    await act(async () => setup.renderer.destroy())
    syntax.destroy()
  }
})

test("metadata-only file changes explain that no textual patch is available", async () => {
  const syntax = createEmberTideSyntax()
  const setup = await testRender(
    <FileChange
      folded={false}
      syntax={syntax}
      item={{
        id: itemId("empty"),
        turnId: turnId("turn"),
        kind: "edit",
        title: "old.bin",
        status: "complete",
        patch: "",
        changes: [
          { path: "old.bin", movePath: "new.bin", action: "update", patch: "" },
        ],
      }}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => setup.flush())
    expect(setup.captureCharFrame()).toContain("old.bin → new.bin")
    expect(setup.captureCharFrame()).toContain("No textual diff available.")
    expect(setup.renderer.root.findDescendantById("diff:empty")).toBeUndefined()
  } finally {
    await act(async () => setup.renderer.destroy())
    syntax.destroy()
  }
})

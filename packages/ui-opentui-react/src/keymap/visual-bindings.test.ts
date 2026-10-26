import { describe, expect, test } from "bun:test"
import type { VimBindingContext } from "./binding-context"
import { normalBindings } from "./normal-bindings"
import { visualBindings } from "./visual-bindings"

function context(
  surface: "transcript" | "composer",
  shape: "character" | "line" | "block" = "character",
) {
  const commands: unknown[] = []
  const keys: string[] = []
  const ctx = {
    interaction: { surface, mode: "visual" },
    transcript: { selection: { shape } },
    controller: {
      dispatchInteraction: (command: unknown) => commands.push(command),
      transcript: (command: unknown) => commands.push(command),
    },
    countRef: { current: "3" },
    runComposerKey: (key: string) => keys.push(key),
  } as unknown as VimBindingContext
  return { ctx, commands, keys }
}

describe("visual key routing", () => {
  for (const [key, shape] of [
    ["v", "character"],
    ["shift+v", "line"],
    ["ctrl+v", "block"],
  ] as const) {
    test(`${key} exits the matching transcript selection shape`, () => {
      const { ctx, commands } = context("transcript", shape)
      visualBindings(ctx)
        .find((binding) => binding.key === key)!
        .cmd()
      expect(commands).toEqual([
        { type: "count.clear" },
        { type: "selection.clear" },
        { type: "mode.normal" },
      ])
      expect(ctx.countRef.current).toBe("")
    })

    test(`${key} switches transcript shape without restarting the selection`, () => {
      const { ctx, commands } = context(
        "transcript",
        shape === "character" ? "line" : "character",
      )
      visualBindings(ctx)
        .find((binding) => binding.key === key)!
        .cmd()
      expect(commands).toEqual([
        { type: "count.clear" },
        { type: "selection.shape", shape },
      ])
    })
  }

  test("composer visual motions and endpoint commands reach the grammar once", () => {
    const { ctx, keys, commands } = context("composer")
    const bindings = visualBindings(ctx)
    for (const key of [
      "v",
      "shift+v",
      "o",
      "shift+w",
      "shift+b",
      "shift+e",
      "0",
    ]) {
      const matches = bindings.filter((binding) => binding.key === key)
      expect(matches).toHaveLength(1)
      matches[0]!.cmd()
    }
    expect(keys).toEqual([
      "v",
      "shift+v",
      "o",
      "shift+w",
      "shift+b",
      "shift+e",
      "0",
    ])
    expect(commands).toEqual([])
  })

  test("bracket objects temporarily replace agent-navigation prefixes", () => {
    const { ctx } = context("composer")
    const idle = normalBindings(ctx).map((binding) => binding.key)
    expect(idle).toContain("[a")
    expect(idle).toContain("]a")
    expect(idle).not.toContain("[")
    expect(idle).not.toContain("]")
    ctx.interaction.pendingKeys = "ci"
    const pending = normalBindings(ctx).map((binding) => binding.key)
    expect(pending).toContain("[")
    expect(pending).toContain("]")
    expect(pending).not.toContain("[a")
    expect(pending).not.toContain("]a")
  })

  test("normal composer change text objects reach the grammar", () => {
    const { ctx, keys } = context("composer")
    ctx.interaction.pendingKeys = "ci"
    const bindings = normalBindings(ctx)
    for (const key of [
      "c",
      "i",
      "w",
      '"',
      "'",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "shift+[",
      "shift+]",
      "shift+w",
      "shift+b",
      "shift+v",
    ]) {
      const matches = bindings.filter((binding) => binding.key === key)
      expect(matches).toHaveLength(1)
      matches[0]!.cmd()
    }
    expect(keys).toEqual([
      "c",
      "i",
      "w",
      '"',
      "'",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "shift+[",
      "shift+]",
      "shift+w",
      "shift+b",
      "shift+v",
    ])
  })
})

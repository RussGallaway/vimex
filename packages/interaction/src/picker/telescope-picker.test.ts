import { describe, expect, test } from "bun:test"
import { TelescopePicker, fzfScore } from "./telescope-picker"

describe("fzfScore", () => {
  test("matches subsequences and reports highlighted positions", () => {
    expect(fzfScore("fb", "foo/bar")).toEqual({
      score: expect.any(Number),
      positions: [0, 4],
    })
    expect(fzfScore("zz", "foo/bar")).toBeNull()
  })

  test("prefers boundary and consecutive matches", () => {
    const boundary = fzfScore("fb", "foo/bar")!
    const embedded = fzfScore("fb", "snafu bits")!
    expect(boundary.score).toBeGreaterThan(embedded.score)
  })

  test("treats whitespace-separated terms as an AND query", () => {
    expect(fzfScore("foo bar", "src/foo/bar.ts")?.positions).toEqual([
      4, 5, 6, 8, 9, 10,
    ])
    expect(fzfScore("foo missing", "src/foo/bar.ts")).toBeNull()
  })

  test("keeps Unicode code points intact", () => {
    expect(fzfScore("😀", "x😀")?.positions).toEqual([1])
  })
})

describe("TelescopePicker", () => {
  test("ranks, navigates, and preserves ordered marks", async () => {
    const picker = new TelescopePicker({
      finder: () => [
        { id: "a", text: "alpha", value: 1 },
        { id: "b", text: "beta", value: 2 },
        { id: "g", text: "gamma", value: 3 },
      ],
    })
    await picker.refresh()
    picker.setQuery("a")
    expect(picker.results.map((entry) => entry.id)).toEqual(["a", "g", "b"])
    picker.move(1)
    picker.toggleMark()
    picker.move(1)
    picker.toggleMark()
    expect(picker.markedIds).toEqual(["g", "b"])
    expect(picker.accept().map((entry) => entry.id)).toEqual(["g", "b"])
  })

  test("ignores stale asynchronous finder results", async () => {
    let resolveFirst!: (
      entries: readonly { id: string; text: string; value: string }[],
    ) => void
    const first = new Promise<
      readonly { id: string; text: string; value: string }[]
    >((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    const picker = new TelescopePicker({
      finder: (signal) => {
        calls++
        return calls === 1 ? first : []
      },
    })
    const stale = picker.refresh()
    const current = picker.refresh()
    resolveFirst([{ id: "old", text: "old", value: "old" }])
    await Promise.all([stale, current])
    expect(picker.results).toEqual([])
  })
})

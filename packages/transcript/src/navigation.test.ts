import { describe, expect, test } from "bun:test"
import { itemId, turnId } from "@vimex/conversation"
import { assistantMessage as message } from "@vimex/testkit"
import {
  adjacentSearchMatch,
  beginSelection,
  findSearchMatches,
  firstContentPoint,
  graphemeCount,
  initialTranscript,
  moveByMessage,
  moveByWord,
  selectedText,
  moveBySemanticBlock,
  moveByUrl,
  moveByUrlReference,
  moveCursor,
  referenceText,
  reduceTranscript,
  semanticBlocks,
  swapSelection,
  syncTranscriptItem,
  transcriptOrderIndex,
  primeTranscriptUrlIndex,
  urlCandidates,
  urlCandidatesReference,
} from "./index"

describe("logical transcript navigation", () => {
  test("moves by semantic blocks and messages and finds first line content", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "  intro\ncontinued\n\n  second"),
    )
    state = syncTranscriptItem(state, message("b", "next"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 4 })

    const blocks = semanticBlocks(state)
    const secondOffset = graphemeCount("  intro\ncontinued\n\n")
    expect(
      blocks.map((block) => [
        block.itemId,
        block.from.graphemeOffset,
        block.to.graphemeOffset,
      ]),
    ).toEqual([
      [itemId("a"), 0, graphemeCount("  intro\ncontinued")],
      [
        itemId("a"),
        secondOffset,
        graphemeCount("  intro\ncontinued\n\n  second"),
      ],
      [itemId("b"), 0, 4],
    ])
    expect(firstContentPoint(state)).toEqual({
      itemId: itemId("a"),
      graphemeOffset: 2,
    })
    expect(moveBySemanticBlock(state, "forward")).toEqual({
      itemId: itemId("a"),
      graphemeOffset: secondOffset,
    })
    expect(moveBySemanticBlock(state, "forward", state.cursor, 2)).toEqual({
      itemId: itemId("b"),
      graphemeOffset: 0,
    })
    expect(moveBySemanticBlock(state, "backward")).toEqual({
      itemId: itemId("a"),
      graphemeOffset: 0,
    })
    expect(moveByMessage(state, "forward")).toEqual({
      itemId: itemId("b"),
      graphemeOffset: 0,
    })
    expect(moveByMessage(state, "backward")).toBeUndefined()
  })

  test("message motions skip tool nodes while reasoning has no transcript position", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("first", "first"),
    )
    state = syncTranscriptItem(state, {
      id: itemId("reasoning"),
      turnId: turnId("turn"),
      kind: "reasoning",
      markdown: "thinking",
      status: "complete",
    })
    state = syncTranscriptItem(state, {
      id: itemId("tool"),
      turnId: turnId("turn"),
      kind: "command",
      title: "Run",
      detail: "output",
      status: "complete",
    })
    state = syncTranscriptItem(state, message("second", "second"))
    expect(state.order).not.toContain(itemId("reasoning"))
    expect(state.projectionById[itemId("reasoning")]).toBeUndefined()
    expect(
      moveByMessage(state, "forward", {
        itemId: itemId("first"),
        graphemeOffset: 0,
      }),
    ).toEqual({ itemId: itemId("second"), graphemeOffset: 0 })
    expect(
      moveByMessage(state, "backward", {
        itemId: itemId("tool"),
        graphemeOffset: 0,
      }),
    ).toEqual({ itemId: itemId("first"), graphemeOffset: 0 })
    expect(
      moveByMessage(state, "forward", {
        itemId: itemId("tool"),
        graphemeOffset: 0,
      }),
    ).toEqual({ itemId: itemId("second"), graphemeOffset: 0 })
  })

  test("nearby message and semantic-block motions do not scan unrelated 100k history", () => {
    const ids = Object.freeze(
      Array.from({ length: 100_000 }, (_, index) => itemId(`nearby-${index}`)),
    )
    const order = new Proxy(ids, {
      get(target, property, receiver) {
        if (property === "indexOf")
          return () => {
            throw new Error("navigation scanned logical order")
          }
        return Reflect.get(target, property, receiver)
      },
    })
    const projected = syncTranscriptItem(
      initialTranscript(),
      message("seed", "one block"),
    ).projectionById[itemId("seed")]!
    let projectionReads = 0
    const projectionById = new Proxy(
      Object.fromEntries(ids.map((id) => [id, projected])),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && property.startsWith("nearby-"))
            projectionReads++
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const state = { ...initialTranscript(), order, projectionById }
    transcriptOrderIndex(order)
    const origin = { itemId: ids[50_000]!, graphemeOffset: 0 }
    expect(moveByMessage(state, "forward", origin)).toEqual({
      itemId: ids[50_001]!,
      graphemeOffset: 0,
    })
    expect(moveBySemanticBlock(state, "forward", origin)).toEqual({
      itemId: ids[50_001]!,
      graphemeOffset: 0,
    })
    expect(projectionReads).toBeLessThanOrEqual(6)
  })

  test("references a selection first and otherwise the current semantic block", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "first block\nline two\n\nsecond block"),
    )
    const second = graphemeCount("first block\nline two\n\n")
    state = moveCursor(state, {
      itemId: itemId("a"),
      graphemeOffset: second + 2,
    })
    expect(referenceText(state)).toBe("second block")

    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 4 })
    expect(referenceText(state)).toBe("first")
    const swapped = swapSelection(state)
    expect(swapped.selection).toEqual({
      anchor: { itemId: itemId("a"), graphemeOffset: 4 },
      head: { itemId: itemId("a"), graphemeOffset: 0 },
      shape: "character",
    })
    expect(swapped.cursor).toEqual(swapped.selection?.head)
  })

  test("indexes URL candidates by scope and moves in either direction", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "[one](https://one.test) then https://two.test/a_(b)."),
    )
    state = syncTranscriptItem(state, message("b", "<file://folder/name>"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })

    expect(urlCandidates(state).map(({ text, url }) => [text, url])).toEqual([
      ["one", "https://one.test"],
      ["https://two.test/a_(b)", "https://two.test/a_(b)"],
      ["file://folder/name", "file://folder/name"],
    ])
    expect(urlCandidates(state, "current-item")).toHaveLength(2)
    expect(moveByUrl(state, "forward")).toEqual(urlCandidates(state)[1]!.from)
    expect(moveByUrl(state, "backward", state.cursor, { wrap: true })).toEqual(
      urlCandidates(state)[2]!.from,
    )

    state = beginSelection(state, "character")
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 2 })
    expect(urlCandidates(state, "selection").map(({ url }) => url)).toEqual([
      "https://one.test",
    ])
    for (const scope of ["all", "current-item", "selection"] as const)
      expect(urlCandidates(state, scope)).toEqual(
        urlCandidatesReference(state, scope),
      )

    state = moveCursor(state, urlCandidatesReference(state)[1]!.from)
    expect(urlCandidates(state, "selection").map(({ url }) => url)).toEqual([
      "https://one.test",
      "https://two.test/a_(b)",
    ])
    expect(urlCandidates(state, "selection")).toEqual(
      urlCandidatesReference(state, "selection"),
    )
    const reversed = swapSelection(state)
    expect(urlCandidates(reversed, "selection")).toEqual(
      urlCandidatesReference(reversed, "selection"),
    )

    const staleCursor = {
      ...state,
      cursor: { itemId: itemId("outside-order"), graphemeOffset: 0 },
      projectionById: {
        ...state.projectionById,
        [itemId("outside-order")]: state.projectionById[itemId("a")]!,
      },
    }
    expect(urlCandidates(staleCursor, "current-item")).toEqual(
      urlCandidatesReference(staleCursor, "current-item"),
    )
  })

  test("warm sparse URL motion is logarithmic across 100k unrelated items", () => {
    const ids = Object.freeze(
      Array.from({ length: 100_000 }, (_, index) => itemId(`url-${index}`)),
    )
    const plain = syncTranscriptItem(
      initialTranscript(),
      message("plain-url-fixture", "plain"),
    ).projectionById[itemId("plain-url-fixture")]!
    const linked = syncTranscriptItem(
      initialTranscript(),
      message("linked-url-fixture", "[link](https://example.test)"),
    ).projectionById[itemId("linked-url-fixture")]!
    const projectionById = Object.freeze(
      Object.fromEntries(
        ids.map((id, index) => [id, index % 10_000 === 0 ? linked : plain]),
      ),
    )
    const state = {
      ...initialTranscript(),
      order: ids,
      projectionById,
      cursor: { itemId: ids[50_000]!, graphemeOffset: 0 },
    }
    const diagnostics = {
      urlIndexBuilds: 0,
      urlIndexItemVisits: 0,
      urlIndexCacheHits: 0,
      urlIndexUpdates: 0,
      urlIndexNodeVisits: 0,
    }
    primeTranscriptUrlIndex(state, diagnostics)
    const before = { ...diagnostics }
    expect(
      moveByUrl(state, "forward", state.cursor, { wrap: true }, diagnostics),
    ).toEqual({ itemId: ids[60_000]!, graphemeOffset: 0 })
    expect(diagnostics.urlIndexBuilds - before.urlIndexBuilds).toBe(0)
    expect(diagnostics.urlIndexItemVisits - before.urlIndexItemVisits).toBe(0)
    expect(diagnostics.urlIndexCacheHits - before.urlIndexCacheHits).toBe(1)
    expect(
      diagnostics.urlIndexNodeVisits - before.urlIndexNodeVisits,
    ).toBeLessThanOrEqual(4 * Math.ceil(Math.log2(ids.length)) + 5)
  })
})

describe("transcript search", () => {
  test("finds overlapping grapheme matches and navigates with wrapping", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "AaA 👨‍👩‍👧‍👦 aaa"),
    )
    state = syncTranscriptItem(state, message("b", "AAA"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })

    const matches = findSearchMatches(state, "aa")
    expect(
      matches.map((match) => [match.itemId, match.from.graphemeOffset]),
    ).toEqual([
      [itemId("a"), 0],
      [itemId("a"), 1],
      [itemId("a"), 6],
      [itemId("a"), 7],
      [itemId("b"), 0],
      [itemId("b"), 1],
    ])
    expect(
      findSearchMatches(state, "aa", { caseSensitive: true }),
    ).toHaveLength(2)
    expect(adjacentSearchMatch(state, matches, "forward")?.from).toEqual(
      matches[1]!.from,
    )
    expect(adjacentSearchMatch(state, matches, "backward")?.from).toEqual(
      matches.at(-1)!.from,
    )
    expect(
      adjacentSearchMatch(state, matches, "forward", matches.at(-1)!.from)
        ?.from,
    ).toEqual(matches[0]!.from)
    expect(findSearchMatches(state, "👨‍👩‍👧‍👦")[0]?.to.graphemeOffset).toBe(5)
  })

  test("finds the adjacent match without scanning every match against the full item order", () => {
    let state = initialTranscript()
    for (let index = 0; index < 300; index++)
      state = syncTranscriptItem(
        state,
        message(`search-${index}`, "a ".repeat(40)),
      )
    const matches = findSearchMatches(state, "a")
    const point = { itemId: itemId("search-150"), graphemeOffset: 20 }
    let matchReads = 0,
      orderReads = 0
    const observedMatches = new Proxy(matches, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) matchReads++
        return Reflect.get(target, key, receiver)
      },
    })
    const observedOrder = new Proxy(state.order, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) orderReads++
        return Reflect.get(target, key, receiver)
      },
    })
    expect(
      adjacentSearchMatch(
        { ...state, order: observedOrder },
        observedMatches,
        "forward",
        point,
      )?.from,
    ).toEqual({ ...point, graphemeOffset: 22 })
    expect(matchReads).toBeLessThanOrEqual(
      Math.ceil(Math.log2(matches.length)) + 2,
    )
    expect(orderReads).toBeLessThanOrEqual(state.order.length)
  })
})

describe("Vim transcript word motions", () => {
  test("distinguishes words from WORDs with counted punctuation and boundaries", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "one.two  three"),
    )
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    expect(moveByWord(state, "next")?.graphemeOffset).toBe(3)
    expect(moveByWord(state, "next", state.cursor, 2)?.graphemeOffset).toBe(4)
    expect(
      moveByWord(state, "next", state.cursor, 1, true)?.graphemeOffset,
    ).toBe(9)
    expect(moveByWord(state, "end")?.graphemeOffset).toBe(2)
    expect(
      moveByWord(state, "end", state.cursor, 1, true)?.graphemeOffset,
    ).toBe(6)
    expect(moveByWord(state, "next", state.cursor, 100)?.graphemeOffset).toBe(
      13,
    )
    expect(moveByWord(state, "previous")?.graphemeOffset).toBe(0)
    expect(
      moveByWord(state, "previous", { itemId: itemId("a"), graphemeOffset: 6 })
        ?.graphemeOffset,
    ).toBe(4)
  })

  test("short motions do not segment unrelated large transcript items", () => {
    let state = initialTranscript()
    for (let index = 0; index < 100; index++)
      state = syncTranscriptItem(
        state,
        message(
          `word-${index}`,
          "alpha beta gamma delta https://example.test\n".repeat(100),
        ),
      )
    const accessed: string[] = []
    state = {
      ...state,
      projectionById: Object.fromEntries(
        Object.entries(state.projectionById).map(([id, projection]) => [
          id,
          {
            ...projection,
            get plain() {
              accessed.push(id)
              return projection.plain
            },
          },
        ]),
      ),
    }
    const target = moveByWord(state, "next", {
      itemId: itemId("word-0"),
      graphemeOffset: 0,
    })
    expect(target).toEqual({ itemId: itemId("word-0"), graphemeOffset: 6 })
    expect(accessed).toEqual(["word-0"])
  })

  test("crosses empty items and newlines without splitting Unicode graphemes", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "café 👨‍👩‍👧‍👦\nnext"),
    )
    state = syncTranscriptItem(state, message("empty", ""))
    state = syncTranscriptItem(state, message("b", "日本語 last"))
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    expect(moveByWord(state, "end")?.graphemeOffset).toBe(3)
    expect(moveByWord(state, "next")?.graphemeOffset).toBe(5)
    expect(moveByWord(state, "next", state.cursor, 3)).toEqual({
      itemId: itemId("b"),
      graphemeOffset: 0,
    })
    expect(
      moveByWord(state, "previous", { itemId: itemId("b"), graphemeOffset: 0 }),
    ).toEqual({ itemId: itemId("a"), graphemeOffset: 7 })
    expect(
      moveByWord(state, "end", { itemId: itemId("b"), graphemeOffset: 0 }),
    ).toEqual({ itemId: itemId("b"), graphemeOffset: 2 })
  })

  test("extends a semantic Visual range while canonical Markdown copy stays exact", () => {
    let state = syncTranscriptItem(
      initialTranscript(),
      message("a", "[café](https://example.test) next"),
    )
    state = moveCursor(state, { itemId: itemId("a"), graphemeOffset: 0 })
    state = beginSelection(state, "character")
    state = moveCursor(state, moveByWord(state, "end")!)
    expect(state.selection?.anchor.graphemeOffset).toBe(0)
    expect(state.selection?.head.graphemeOffset).toBe(3)
    expect(selectedText(state, "plain")).toBe("café")
    expect(selectedText(state, "source")).toBe("[café](https://example.test)")
    state = moveCursor(state, moveByWord(state, "end")!)
    expect(selectedText(state, "plain")).toBe("café next")
  })
})

test("URL and block motions normalize counts consistently with search and word motions", () => {
  const state = syncTranscriptItem(
    initialTranscript(),
    message("a", "intro\n\n[one](https://one.test)\n\n[two](https://two.test)"),
  )
  const origin = { itemId: itemId("a"), graphemeOffset: 0 }
  for (const count of [NaN, Infinity, -Infinity, 0, -3, 1.9]) {
    expect(moveByUrl(state, "forward", origin, { count })).toEqual(
      urlCandidates(state)[0]!.from,
    )
    expect(moveBySemanticBlock(state, "forward", origin, count)).toEqual(
      semanticBlocks(state)[1]!.from,
    )
  }
  expect(moveByUrl(state, "forward", origin, { count: 3, wrap: true })).toEqual(
    urlCandidates(state)[0]!.from,
  )
  expect(
    moveByUrl(state, "forward", origin, { count: 3, wrap: false }),
  ).toBeUndefined()
  for (const direction of ["forward", "backward"] as const)
    for (const count of [1, 2, 3, Number.NaN])
      for (const wrap of [false, true]) {
        expect(moveByUrl(state, direction, origin, { count, wrap })).toEqual(
          moveByUrlReference(state, direction, origin, { count, wrap }),
        )
      }
})

test("folded tools are one block in either direction without losing explicit reveal targets", () => {
  let state = syncTranscriptItem(
    initialTranscript(),
    message("before", "Before"),
  )
  const tool = itemId("folded-tool")
  state = syncTranscriptItem(state, {
    id: tool,
    turnId: turnId("turn"),
    kind: "command",
    title: "Run",
    detail: "first paragraph\n\nlast paragraph",
    status: "complete",
  })
  state = syncTranscriptItem(state, message("after", "After"))
  state = reduceTranscript(state, {
    type: "fold.set",
    itemId: tool,
    folded: true,
  })
  const header = { itemId: tool, graphemeOffset: 0 }
  expect(
    moveBySemanticBlock(state, "forward", {
      itemId: itemId("before"),
      graphemeOffset: 0,
    }),
  ).toEqual(header)
  expect(
    moveBySemanticBlock(state, "backward", {
      itemId: itemId("after"),
      graphemeOffset: 0,
    }),
  ).toEqual(header)
  expect(moveBySemanticBlock(state, "forward", header)).toEqual({
    itemId: itemId("after"),
    graphemeOffset: 0,
  })
  state = reduceTranscript(state, {
    type: "jump.to",
    target: { point: header, preferredScreenRow: 2 },
    preserveFolds: true,
  })
  expect(state.folded[tool]).toBe(true)
  const output = { itemId: tool, graphemeOffset: 19 }
  state = reduceTranscript(state, {
    type: "mark.set",
    name: "a",
    target: { point: output, preferredScreenRow: 2 },
  })
  state = reduceTranscript(state, { type: "mark.jump", name: "a" })
  expect(state.folded[tool]).toBe(false)
  expect(state.cursor).toEqual(output)
  state = reduceTranscript(state, {
    type: "fold.set",
    itemId: tool,
    folded: true,
  })
  state = reduceTranscript(state, {
    type: "search.jump",
    target: { point: output, preferredScreenRow: 2 },
  })
  expect(state.folded[tool]).toBe(false)
  expect(state.cursor).toEqual(output)
})

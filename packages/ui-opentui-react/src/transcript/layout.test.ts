import { describe, expect, test } from "bun:test"
import { itemId } from "@vimex/conversation"
import {
  composeTranscriptGeometry,
  graphemeCount,
  initialTranscript,
  projectMarkdown,
  transcriptOrderIndex,
  type BlockGeometry,
  type TranscriptState,
} from "@vimex/transcript"
import {
  blockRefForPoint,
  buildTranscriptLayout,
  graphemeCellWidth,
  materializedSelectionEndpoints,
  movePoint,
  movePointInTranscript,
  pointInLayout,
  selectedRangeForItem,
} from "./layout"
import { rebaseTranscriptLayout } from "./rendered-layout"

const first = itemId("first")
const second = itemId("second")

test("layout-disabled activity children cannot disturb visible row ordering", () => {
  const state = stateFor("first", "second")
  const base = buildTranscriptLayout(state, 80)
  const key = "item:second:root"
  const zero: BlockGeometry = {
    key: {
      blockKey: key,
      contentRevision: 1,
      width: 80,
      styleRevision: "test",
      folded: true,
      presentation: "activity-hidden",
    },
    nativeRevision: 1,
    rows: 0,
    points: {},
    lines: [],
  }
  const geometry = {
    generation: 0,
    revision: 1,
    byBlockKey: { [key]: zero },
    rowByBlockKey: {},
    blockRows: [],
    totalRows: 1,
    measuredBlockCount: 1,
    totalPoints: 0,
  }
  const layout = {
    ...base,
    placementByBlockKey: {
      first: { screenX: 0, screenY: 10 },
      [key]: { screenX: 0, screenY: 0 },
    },
    screenBlockRows: [
      { blockKey: "first", itemId: first, screenY: 10, rows: 1 },
      { blockKey: key, itemId: second, screenY: 0, rows: 1 },
    ],
  }
  expect(
    rebaseTranscriptLayout(layout, geometry).screenBlockRows?.map(
      (row) => row.itemId,
    ),
  ).toEqual([first])
})

function stateFor(firstText: string, secondText = ""): TranscriptState {
  return {
    ...initialTranscript(),
    order: secondText ? [first, second] : [first],
    projectionById: {
      [first]: { ...projectMarkdown(firstText), revision: 1 },
      ...(secondText
        ? { [second]: { ...projectMarkdown(secondText), revision: 1 } }
        : {}),
    },
  }
}

describe("transcript visual layout", () => {
  test("maps vertical motions to exact grapheme offsets across wrapped rows", () => {
    const layout = buildTranscriptLayout(stateFor("abcdEFGH"), 4)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 3, row: 0 },
      { itemId: first, from: 4, to: 8, row: 1 },
    ])
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 2 }, "down"),
    ).toEqual({
      point: { itemId: first, graphemeOffset: 6 },
      preferredScreenRow: 1,
    })
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 6 }, "up"),
    ).toEqual({
      point: { itemId: first, graphemeOffset: 2 },
      preferredScreenRow: 0,
    })
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 2 }, "line-end")?.point
        .graphemeOffset,
    ).toBe(3)
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 3 }, "right")?.point
        .graphemeOffset,
    ).toBe(4)
  })

  test("counts emoji as one logical point while respecting its terminal width", () => {
    const layout = buildTranscriptLayout(stateFor("a🙂bc"), 3)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 1, row: 0 },
      { itemId: first, from: 2, to: 4, row: 1 },
    ])
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 1 }, "right")?.point
        .graphemeOffset,
    ).toBe(2)
  })

  test("assigns newline cursor positions to the following logical row", () => {
    const layout = buildTranscriptLayout(stateFor("ab\ncd"), 20)
    expect(layout.lines).toEqual([
      { itemId: first, from: 0, to: 1, row: 0 },
      { itemId: first, from: 2, to: 5, row: 1 },
    ])
    expect(
      movePoint(layout, { itemId: first, graphemeOffset: 1 }, "right")?.point
        .graphemeOffset,
    ).toBe(2)
  })

  test("projects character and whole-line selections across items", () => {
    const base = stateFor("one\ntwo", "three")
    const character: TranscriptState = {
      ...base,
      selection: {
        anchor: { itemId: first, graphemeOffset: 5 },
        head: { itemId: second, graphemeOffset: 1 },
        shape: "character",
      },
    }
    expect(selectedRangeForItem(character, first)).toEqual({ from: 5, to: 7 })
    expect(selectedRangeForItem(character, second)).toEqual({ from: 0, to: 2 })
    const line: TranscriptState = {
      ...base,
      selection: {
        anchor: { itemId: first, graphemeOffset: 5 },
        head: { itemId: first, graphemeOffset: 5 },
        shape: "line",
      },
    }
    expect(selectedRangeForItem(line, first)).toEqual({ from: 4, to: 7 })
  })

  test("reuses a 100k logical-order index for bounded mounted selection checks", () => {
    const ids = Object.freeze(
      Array.from({ length: 100_000 }, (_, index) => itemId(`indexed-${index}`)),
    )
    const order = new Proxy(ids, {
      get(target, property, receiver) {
        if (property === "indexOf")
          return () => {
            throw new Error("selection lookup scanned logical order")
          }
        return Reflect.get(target, property, receiver)
      },
    })
    const start = order[50_000]!,
      end = order[50_047]!
    const projection = { ...projectMarkdown("x"), revision: 1 }
    const state: TranscriptState = {
      ...initialTranscript(),
      order,
      projectionById: Object.fromEntries(
        order.slice(50_000, 50_048).map((id) => [id, projection]),
      ),
      selection: {
        anchor: { itemId: start, graphemeOffset: 0 },
        head: { itemId: end, graphemeOffset: 0 },
        shape: "character",
      },
    }
    const index = transcriptOrderIndex(order)
    expect(index.size).toBe(100_000)
    expect(
      order
        .slice(50_000, 50_048)
        .filter((id) => selectedRangeForItem(state, id)),
    ).toHaveLength(48)
    expect(transcriptOrderIndex(order)).toBe(index)
  })

  test("targeted off-window motion equals the complete estimated-layout oracle", () => {
    const ids = [first, second, itemId("empty"), itemId("last")]
    const texts = ["abcdEFGH", "e\nfg", "", "🙂zz"]
    const state: TranscriptState = {
      ...initialTranscript(),
      order: ids,
      projectionById: Object.fromEntries(
        ids.map((id, index) => [
          id,
          { ...projectMarkdown(texts[index]!), revision: 1 },
        ]),
      ),
    }
    const oracle = buildTranscriptLayout(state, 4)
    const motions = [
      "left",
      "right",
      "up",
      "down",
      "line-start",
      "line-end",
      "first",
      "last",
    ] as const
    const completeMotion = (
      point: { itemId: typeof first; graphemeOffset: number },
      motion: (typeof motions)[number],
      repeat: number,
    ) => {
      let current = point
      let result: ReturnType<typeof movePoint>
      let moved = false
      const crossing =
        motion === "left" ||
        motion === "right" ||
        motion === "up" ||
        motion === "down"
      for (let index = 0; index < repeat; index++) {
        result = movePoint(oracle, current, motion)
        if (!result) return undefined
        if (
          result.point.itemId === current.itemId &&
          result.point.graphemeOffset === current.graphemeOffset
        ) {
          return crossing && !moved ? undefined : result
        }
        moved = true
        current = result.point
      }
      return result
    }
    for (const id of ids) {
      const length = state.projectionById[id]!.sourceSpans.length
      for (let offset = 0; offset <= length; offset++)
        for (const motion of motions)
          for (const repeat of [1, 2, 5]) {
            const point = { itemId: id, graphemeOffset: offset }
            const targeted = movePointInTranscript(
              state,
              4,
              point,
              motion,
              repeat,
            )
            expect(targeted?.point).toEqual(
              completeMotion(point, motion, repeat)?.point,
            )
            if (targeted)
              expect(targeted.preferredScreenRow).toBeGreaterThanOrEqual(0)
          }
    }
  })

  test("100k off-window motion wraps only the current and adjacent logical items", () => {
    const ids = Object.freeze(
      Array.from({ length: 100_000 }, (_, index) => itemId(`motion-${index}`)),
    )
    const projection = { ...projectMarkdown("x"), revision: 1 }
    const state: TranscriptState = {
      ...initialTranscript(),
      order: ids,
      projectionById: Object.fromEntries(ids.map((id) => [id, projection])),
    }
    transcriptOrderIndex(ids)
    const diagnostics = { wrappedItems: 0, itemTransitions: 0 }
    expect(
      movePointInTranscript(
        state,
        8,
        { itemId: ids[50_000]!, graphemeOffset: 0 },
        "left",
        1,
        diagnostics,
      )?.point,
    ).toEqual({ itemId: ids[49_999]!, graphemeOffset: 1 })
    expect(diagnostics).toEqual({ wrappedItems: 2, itemTransitions: 1 })
    const boundary = { wrappedItems: 0, itemTransitions: 0 }
    expect(
      movePointInTranscript(
        state,
        8,
        { itemId: ids[50_000]!, graphemeOffset: 0 },
        "first",
        1,
        boundary,
      )?.point,
    ).toEqual({ itemId: ids[0]!, graphemeOffset: 0 })
    expect(boundary).toEqual({ wrappedItems: 1, itemTransitions: 0 })
  })
})

test("combining marks do not erase the terminal width of their base grapheme", () => {
  expect(graphemeCellWidth("é")).toBe(1)
  expect(graphemeCellWidth("界́")).toBe(2)
  expect(graphemeCellWidth("́")).toBe(0)
  expect(buildTranscriptLayout(stateFor("éabc"), 2).lines).toEqual([
    { itemId: first, from: 0, to: 1, row: 0 },
    { itemId: first, from: 2, to: 4, row: 1 },
  ])
})

test("uses terminal cell widths for flags, keycaps, and supplementary CJK", () => {
  expect(graphemeCellWidth("🇺🇸")).toBe(2)
  expect(graphemeCellWidth("1️⃣")).toBe(2)
  expect(graphemeCellWidth("𠀀")).toBe(2)
})

test("estimated geometry keeps folded content on one visual row", () => {
  const state = stateFor("one two three four")
  const folded = { ...state, folded: { [first]: true } }
  expect(buildTranscriptLayout(folded, 4).lines).toEqual([
    { itemId: first, from: 0, to: graphemeCount("one two three four"), row: 0 },
  ])
})

test("measured row navigation stays column-aware and builds a fresh index after reflow", () => {
  const make = (column: number) => ({
    ...buildTranscriptLayout(stateFor("abcd"), 2),
    points: {
      [first]: {
        0: {
          itemId: first,
          graphemeOffset: 0,
          row: 0,
          column: 0,
          screenX: 0,
          screenY: 0,
        },
        1: {
          itemId: first,
          graphemeOffset: 1,
          row: 0,
          column: 1,
          screenX: 1,
          screenY: 0,
        },
        2: {
          itemId: first,
          graphemeOffset: 2,
          row: 1,
          column,
          screenX: column,
          screenY: 1,
        },
        3: {
          itemId: first,
          graphemeOffset: 3,
          row: 1,
          column: 1,
          screenX: 1,
          screenY: 1,
        },
      },
    },
  })
  const firstLayout = make(0)
  expect(
    movePoint(firstLayout, { itemId: first, graphemeOffset: 0 }, "down")?.point
      .graphemeOffset,
  ).toBe(2)
  expect(
    movePoint(firstLayout, { itemId: first, graphemeOffset: 1 }, "down")?.point
      .graphemeOffset,
  ).toBe(3)
  expect(
    movePoint(make(4), { itemId: first, graphemeOffset: 0 }, "down")?.point
      .graphemeOffset,
  ).toBe(3)
})

test("measured inclusive row endpoints retain their own row for horizontal motions", () => {
  const layout = {
    ...buildTranscriptLayout(stateFor("abcd"), 2),
    lines: [
      { itemId: first, from: 0, to: 1, row: 0 },
      { itemId: first, from: 2, to: 3, row: 1 },
    ],
    points: {
      [first]: {
        1: {
          itemId: first,
          graphemeOffset: 1,
          row: 0,
          column: 1,
          screenX: 1,
          screenY: 0,
        },
      },
    },
  }
  layout.linesByItem = { [first]: layout.lines }
  const point = { itemId: first, graphemeOffset: 1 }
  expect(movePoint(layout, point, "left")?.point.graphemeOffset).toBe(0)
  expect(movePoint(layout, point, "line-start")?.point.graphemeOffset).toBe(0)
  expect(movePoint(layout, point, "line-end")?.point.graphemeOffset).toBe(1)
})

test("block-local geometry composes navigation without cloning historical points", () => {
  const make = (
    id: typeof first,
    text: string,
    rows: readonly (readonly number[])[],
  ): BlockGeometry => {
    const points = Object.fromEntries(
      rows.flatMap((offsets, row) =>
        offsets.map((offset, column) => [
          offset,
          {
            graphemeOffset: offset,
            x: column,
            y: row,
            row,
            column,
          },
        ]),
      ),
    )
    return Object.freeze({
      key: Object.freeze({
        blockKey: `item:${id}:root`,
        contentRevision: 1,
        width: 10,
        styleRevision: "test",
        folded: false,
      }),
      nativeRevision: 1,
      rows: rows.length,
      points: Object.freeze(points),
      lines: Object.freeze(
        rows.map((offsets, row) =>
          Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row }),
        ),
      ),
    })
  }
  const state = stateFor("abcd", "ef")
  const firstGeometry = make(first, "abcd", [
    [0, 1],
    [2, 3],
  ])
  const secondGeometry = make(second, "ef", [[0, 1]])
  const blocks = [
    {
      key: { kind: "item" as const, itemId: first, blockId: "root" },
      contentRevision: 1,
      estimatedRows: 1,
    },
    {
      key: { kind: "item" as const, itemId: second, blockId: "root" },
      contentRevision: 1,
      estimatedRows: 1,
    },
  ] as never
  const geometry = composeTranscriptGeometry(
    blocks,
    state.folded,
    {
      [`item:${first}:root`]: firstGeometry,
      [`item:${second}:root`]: secondGeometry,
    },
    0,
    1,
    10,
    "test",
  )
  const layout = {
    width: 10,
    lines: [],
    linesByItem: {},
    geometry,
    blockKeyByItem: {
      [first]: `item:${first}:root`,
      [second]: `item:${second}:root`,
    },
    placementByBlockKey: {
      [`item:${first}:root`]: { screenX: 4, screenY: 8 },
      [`item:${second}:root`]: { screenX: 4, screenY: 10 },
    },
  }
  expect(
    movePoint(layout, { itemId: first, graphemeOffset: 1 }, "down")?.point,
  ).toEqual({ itemId: first, graphemeOffset: 3 })
  expect(
    movePoint(layout, { itemId: first, graphemeOffset: 3 }, "down")?.point,
  ).toEqual({ itemId: second, graphemeOffset: 1 })
  expect(
    movePoint(layout, { itemId: second, graphemeOffset: 0 }, "first")?.point,
  ).toEqual({ itemId: first, graphemeOffset: 0 })
  expect(geometry.byBlockKey[`item:${first}:root`]!.points).toBe(
    firstGeometry.points,
  )
})

test("native selection clips distant semantic endpoints to bounded materialized geometry", () => {
  const ids = Object.freeze(
    Array.from({ length: 100_000 }, (_, index) => itemId(`selection-${index}`)),
  )
  const projection = { ...projectMarkdown("x"), revision: 1 }
  const state: TranscriptState = {
    ...initialTranscript(),
    order: ids,
    projectionById: Object.fromEntries(ids.map((id) => [id, projection])),
    selection: {
      anchor: { itemId: ids[10]!, graphemeOffset: 0 },
      head: { itemId: ids[99_990]!, graphemeOffset: 0 },
      shape: "character",
    },
  }
  transcriptOrderIndex(ids)
  const mountedIds = ids.slice(50_000, 50_003)
  const blocks = mountedIds.map((id) => ({
    key: { kind: "item" as const, itemId: id, blockId: "root" },
    projection,
    sourceSpan: { from: 0, to: 1 },
    contentRevision: 1,
    estimatedRows: 1,
  })) as never
  const geometries = Object.fromEntries(
    mountedIds.map((id) => [
      `item:${id}:root`,
      {
        key: {
          blockKey: `item:${id}:root`,
          contentRevision: 1,
          width: 10,
          styleRevision: "selection",
          folded: false,
        },
        nativeRevision: 1,
        rows: 1,
        points: { 0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 } },
        lines: [{ from: 0, to: 0, row: 0 }],
      } satisfies BlockGeometry,
    ]),
  )
  const geometry = composeTranscriptGeometry(
    blocks,
    state.folded,
    geometries,
    0,
    0,
  )
  const layout = {
    width: 10,
    materializedBlocks: blocks,
    lines: [],
    linesByItem: {},
    geometry,
    placementByBlockKey: Object.fromEntries(
      mountedIds.map((id, index) => [
        `item:${id}:root`,
        { screenX: 0, screenY: index },
      ]),
    ),
    blockKeysByItem: Object.fromEntries(
      mountedIds.map((id) => [
        id,
        [{ blockKey: `item:${id}:root`, blockId: "root", from: 0, to: 1 }],
      ]),
    ),
  }
  const diagnostics = { blockVisits: 0, pointVisits: 0 }
  expect(
    materializedSelectionEndpoints(state, layout, diagnostics),
  ).toMatchObject({
    anchor: { itemId: mountedIds[0], graphemeOffset: 0 },
    head: { itemId: mountedIds[2], graphemeOffset: 0 },
  })
  expect(diagnostics).toEqual({ blockVisits: 3, pointVisits: 3 })

  const reverse = {
    ...state,
    selection: {
      ...state.selection!,
      anchor: state.selection!.head,
      head: state.selection!.anchor,
    },
  }
  expect(materializedSelectionEndpoints(reverse, layout)).toMatchObject({
    anchor: { itemId: mountedIds[2] },
    head: { itemId: mountedIds[0] },
  })
  const outside = {
    ...state,
    selection: {
      anchor: { itemId: ids[1]!, graphemeOffset: 0 },
      head: { itemId: ids[2]!, graphemeOffset: 0 },
      shape: "character" as const,
    },
  }
  expect(materializedSelectionEndpoints(outside, layout)).toBeUndefined()
})

test("native selection maps folded interior and empty final-sentinel ranges without expanding hidden text", () => {
  const foldedId = itemId("folded-selection")
  const projection = { ...projectMarkdown("abcdef"), revision: 1 }
  const block = {
    key: { kind: "item" as const, itemId: foldedId, blockId: "root" },
    projection,
    sourceSpan: { from: 0, to: 6 },
    contentRevision: 1,
    estimatedRows: 1,
  } as never
  const geometry = composeTranscriptGeometry(
    [block],
    { [foldedId]: true },
    {
      [`item:${foldedId}:root`]: {
        key: {
          blockKey: `item:${foldedId}:root`,
          contentRevision: 1,
          width: 10,
          styleRevision: "selection",
          folded: true,
        },
        nativeRevision: 1,
        rows: 1,
        points: {
          0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0, hidden: true },
          6: { graphemeOffset: 6, x: 0, y: 0, row: 0, column: 0, hidden: true },
        },
        lines: [{ from: 0, to: 6, row: 0 }],
      },
    },
    0,
    0,
  )
  const layout = {
    width: 10,
    materializedBlocks: [block],
    lines: [],
    linesByItem: {},
    geometry,
    placementByBlockKey: {
      [`item:${foldedId}:root`]: { screenX: 0, screenY: 0 },
    },
    blockKeysByItem: {
      [foldedId]: [
        { blockKey: `item:${foldedId}:root`, blockId: "root", from: 0, to: 6 },
      ],
    },
  }
  const state: TranscriptState = {
    ...initialTranscript(),
    order: [foldedId],
    projectionById: { [foldedId]: projection },
    folded: { [foldedId]: true },
    selection: {
      anchor: { itemId: foldedId, graphemeOffset: 2 },
      head: { itemId: foldedId, graphemeOffset: 3 },
      shape: "character",
    },
  }
  expect(materializedSelectionEndpoints(state, layout)).toMatchObject({
    anchor: { itemId: foldedId, graphemeOffset: 2, hidden: true },
    head: { itemId: foldedId, graphemeOffset: 3, hidden: true },
  })
  expect(
    materializedSelectionEndpoints(
      {
        ...state,
        selection: {
          ...state.selection!,
          anchor: state.selection!.head,
          head: state.selection!.anchor,
        },
      },
      layout,
    ),
  ).toMatchObject({
    anchor: { graphemeOffset: 3 },
    head: { graphemeOffset: 2 },
  })

  const emptyId = itemId("empty-folded-selection")
  const emptyProjection = { ...projectMarkdown(""), revision: 1 }
  const emptyBlock = {
    key: { kind: "item" as const, itemId: emptyId, blockId: "root" },
    projection: emptyProjection,
    sourceSpan: { from: 0, to: 0 },
    contentRevision: 1,
    estimatedRows: 1,
  } as never
  const emptyGeometry = composeTranscriptGeometry(
    [emptyBlock],
    { [emptyId]: true },
    {
      [`item:${emptyId}:root`]: {
        key: {
          blockKey: `item:${emptyId}:root`,
          contentRevision: 1,
          width: 10,
          styleRevision: "selection",
          folded: true,
        },
        nativeRevision: 1,
        rows: 1,
        points: {
          0: { graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0, hidden: true },
        },
        lines: [{ from: 0, to: 0, row: 0 }],
      },
    },
    0,
    0,
  )
  expect(
    materializedSelectionEndpoints(
      {
        ...initialTranscript(),
        order: [emptyId],
        projectionById: { [emptyId]: emptyProjection },
        folded: { [emptyId]: true },
        selection: {
          anchor: { itemId: emptyId, graphemeOffset: 0 },
          head: { itemId: emptyId, graphemeOffset: 0 },
          shape: "character",
        },
      },
      {
        width: 10,
        materializedBlocks: [emptyBlock],
        lines: [],
        linesByItem: {},
        geometry: emptyGeometry,
        placementByBlockKey: {
          [`item:${emptyId}:root`]: { screenX: 0, screenY: 0 },
        },
        blockKeysByItem: {
          [emptyId]: [
            {
              blockKey: `item:${emptyId}:root`,
              blockId: "root",
              from: 0,
              to: 0,
            },
          ],
        },
      },
    ),
  ).toMatchObject({
    anchor: { graphemeOffset: 0 },
    head: { graphemeOffset: 0 },
  })
})

test("one semantic item navigates across multiple render blocks", () => {
  const make = (blockId: string, offsets: readonly number[]): BlockGeometry =>
    Object.freeze({
      key: Object.freeze({
        blockKey: `item:${first}:${blockId}`,
        contentRevision: 1,
        width: 10,
        styleRevision: "test",
        folded: false,
      }),
      nativeRevision: 1,
      rows: 1,
      pointCount: offsets.length,
      points: Object.freeze(
        Object.fromEntries(
          offsets.map((offset, column) => [
            offset,
            Object.freeze({
              graphemeOffset: offset,
              x: column,
              y: 0,
              row: 0,
              column,
            }),
          ]),
        ),
      ),
      pointOffsetsByRow: Object.freeze({ 0: Object.freeze([...offsets]) }),
      lines: Object.freeze([
        Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row: 0 }),
      ]),
      lineByRow: Object.freeze({
        0: Object.freeze({ from: offsets[0]!, to: offsets.at(-1)!, row: 0 }),
      }),
    })
  const state = stateFor("abcdef")
  const firstBlock = {
    key: { kind: "item" as const, itemId: first, blockId: "a" },
    contentRevision: 1,
    estimatedRows: 1,
  }
  const secondBlock = {
    key: { kind: "item" as const, itemId: first, blockId: "b" },
    contentRevision: 1,
    estimatedRows: 1,
  }
  const a = make("a", [0, 1, 2])
  const b = make("b", [3, 4, 5])
  const geometry = composeTranscriptGeometry(
    [firstBlock, secondBlock] as never,
    state.folded,
    {
      [`item:${first}:a`]: a,
      [`item:${first}:b`]: b,
    },
    0,
    1,
    10,
    "test",
  )
  const layout = {
    width: 10,
    lines: [],
    linesByItem: {},
    geometry,
    blockKeysByItem: {
      [first]: [
        { blockKey: `item:${first}:a`, blockId: "a", from: 0, to: 3 },
        { blockKey: `item:${first}:b`, blockId: "b", from: 3, to: 6 },
      ],
    },
    placementByBlockKey: {
      [`item:${first}:a`]: { screenX: 0, screenY: 0 },
      [`item:${first}:b`]: { screenX: 0, screenY: 1 },
    },
  }
  expect(
    movePoint(layout, { itemId: first, graphemeOffset: 1 }, "down")?.point,
  ).toEqual({ itemId: first, graphemeOffset: 4 })
  expect(
    movePoint(layout, { itemId: first, graphemeOffset: 2 }, "right")?.point,
  ).toEqual({ itemId: first, graphemeOffset: 3 })
  expect(
    movePoint(layout, { itemId: first, graphemeOffset: 3 }, "left")?.point,
  ).toEqual({ itemId: first, graphemeOffset: 2 })
  expect(
    blockRefForPoint(layout, { itemId: first, graphemeOffset: 3 })?.blockId,
  ).toBe("b")
  expect(
    pointInLayout(layout, { itemId: first, graphemeOffset: 4 })?.screenY,
  ).toBe(1)
})

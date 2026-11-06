import { expect, test } from "bun:test"
import {
  compactPreparedTextLayout,
  prepareCompactTextLayout,
} from "./compact-prepared-text-layout"
import {
  prepareTextLayout,
  type PrepareTextLayoutInput,
} from "./prepared-text-layout"

const fixtures = [
  "",
  "\n\n",
  "abc def  ghi\nlast\n",
  "a\tb\t\n\tend",
  "é中👨‍👩‍👧‍👦 a🙂 z",
  "abcdefghijklmnop   qrs",
  "  a   \n  \n ",
]

for (const widthMethod of ["unicode", "wcwidth", "unicode-wide"] as const)
  for (const wrapMode of ["none", "word", "char"] as const)
    test(`compact ${widthMethod}/${wrapMode} preserves every row and point including boundaries`, () => {
      let supported = 0
      for (const text of fixtures)
        for (const width of [3, 7, 21])
          for (const firstLineOffset of [0, 2]) {
            const input: PrepareTextLayoutInput = {
              text,
              width,
              widthMethod,
              wrapMode,
              firstLineOffset,
              tabWidth: 4,
            }
            const prepared = prepareTextLayout(input)
            if (prepared.status !== "ready") continue
            supported++
            const compact = compactPreparedTextLayout(prepared.layout)
            expect(compact.rowCount).toBe(prepared.layout.rowCount)
            expect(compact.graphemeCount).toBe(prepared.layout.graphemeCount)
            for (const row of prepared.layout.rows)
              expect(compact.row(row.row)).toEqual(row)
            for (const point of prepared.layout.points)
              expect(compact.point(point.graphemeOffset)).toEqual(point)
            expect(compact.payloadBytes).toBe(
              (compact.rowCount + compact.runCount) * 5 * 8,
            )
            expect(compact.runCount).toBeLessThanOrEqual(
              compact.graphemeCount + 1,
            )
          }
      expect(supported).toBeGreaterThan(0)
    })

test("lookup is immutable and rejects invalid indices without exposing buffers", () => {
  const result = prepareCompactTextLayout({
    text: "abc\n",
    width: 5,
    widthMethod: "unicode",
    wrapMode: "word",
  })
  if (result.status !== "ready") throw new Error(result.reason)
  const layout = result.layout
  expect(Object.isFrozen(layout)).toBe(true)
  expect(Object.isFrozen(layout.row(0))).toBe(true)
  expect(Object.isFrozen(layout.point(0))).toBe(true)
  for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(layout.row(index)).toBeUndefined()
    expect(layout.point(index)).toBeUndefined()
  }
  expect(layout.row(layout.rowCount)).toBeUndefined()
  expect(layout.point(layout.graphemeCount + 1)).toBeUndefined()
  expect(layout.point(4)).toMatchObject({ row: 1, column: 0, kind: "end" })
  expect(Object.values(layout).some(ArrayBuffer.isView)).toBe(false)
})

test("uniform text retains runs rather than one record per grapheme", () => {
  const result = prepareCompactTextLayout({
    text: "a".repeat(10_000),
    width: 80,
    widthMethod: "unicode",
    wrapMode: "char",
  })
  if (result.status !== "ready") throw new Error(result.reason)
  const layout = result.layout
  expect(layout.rowCount).toBe(125)
  expect(layout.runCount).toBe(126)
  expect(layout.payloadBytes).toBe(10_040)
  expect(layout.point(9999)).toMatchObject({ row: 124, column: 79 })
  expect(layout.point(10_000)).toMatchObject({
    row: 124,
    column: 80,
    kind: "end",
  })
})

test("unsupported inputs retain explicit refusal and configured limits", () => {
  const base = { width: 5, widthMethod: "unicode", wrapMode: "word" } as const
  for (const input of [
    { ...base, text: "a\r\nb" },
    { ...base, text: "abc", limits: { maxCodeUnits: 2 } },
    { ...base, text: "abc", conceal: true },
  ]) {
    const verbose = prepareTextLayout(input)
    const compact = prepareCompactTextLayout(input)
    expect(verbose.status).toBe("unsupported")
    expect(compact.status).toBe("unsupported")
    if (verbose.status === "unsupported" && compact.status === "unsupported")
      expect(compact.reason).toBe(verbose.reason)
  }
})

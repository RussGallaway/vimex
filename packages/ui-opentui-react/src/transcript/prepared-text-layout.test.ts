import { expect, test } from "bun:test"
import {
  prepareTextLayout,
  type PrepareTextLayoutInput,
} from "./prepared-text-layout"

function ready(text: string, options: Partial<PrepareTextLayoutInput> = {}) {
  const result = prepareTextLayout({
    text,
    width: 5,
    widthMethod: "unicode",
    wrapMode: "word",
    ...options,
  })
  if (result.status !== "ready") throw new Error(result.reason)
  return result.layout
}

test("native prepared rows preserve wrapping boundaries and consumed whitespace", () => {
  const layout = ready("abc def", { firstLineOffset: 2 })
  expect(layout.rowCount).toBe(2)
  expect(
    layout.rows.map(({ startColumn, width }) => [startColumn, width]),
  ).toEqual([
    [0, 3],
    [4, 3],
  ])
  expect(layout.points[0]).toMatchObject({
    row: 0,
    column: 2,
    width: 1,
    visible: true,
  })
  expect(layout.points[3]).toMatchObject({ row: 0, column: 5, visible: false })
  expect(layout.points[4]).toMatchObject({ row: 1, column: 0, visible: true })
  expect(layout.points[7]).toMatchObject({
    row: 1,
    column: 3,
    kind: "end",
    visible: false,
  })
  expect(Object.isFrozen(layout)).toBe(true)
  expect(Object.isFrozen(layout.rows[0])).toBe(true)
  expect(Object.isFrozen(layout.points[0])).toBe(true)
})

test("tabs use native fixed display widths and newline boundaries remain distinct", () => {
  const layout = ready("a\tb\n\n", { tabWidth: 4 })
  expect(
    layout.points.map(({ row, column, width, kind }) => [
      row,
      column,
      width,
      kind,
    ]),
  ).toEqual([
    [0, 0, 1, "text"],
    [0, 1, 4, "tab"],
    [1, 0, 1, "text"],
    [1, 1, 0, "newline"],
    [2, 0, 0, "newline"],
    [3, 0, 0, "end"],
  ])
  expect(layout.rowCount).toBe(4)
  expect(ready("a\tb").tabWidth).toBe(2)
  expect(ready("").rowCount).toBe(1)
  expect(ready("").points).toEqual([
    {
      graphemeOffset: 0,
      row: 0,
      column: 0,
      width: 0,
      kind: "end",
      visible: false,
    },
  ])
})

for (const widthMethod of ["wcwidth", "unicode", "unicode-wide"] as const)
  test(`native ${widthMethod} measures complete Unicode graphemes`, () => {
    const layout = ready("a👨‍👩‍👧‍👦é中", { widthMethod, width: 20 })
    expect(layout.graphemeCount).toBe(4)
    expect(layout.points.map(({ column, width }) => [column, width])).toEqual(
      widthMethod === "wcwidth"
        ? [
            [0, 1],
            [1, 8],
            [9, 1],
            [10, 2],
            [12, 0],
          ]
        : [
            [0, 1],
            [1, 2],
            [3, 1],
            [4, 2],
            [6, 0],
          ],
    )
    expect(layout.rowCount).toBe(1)
  })

test("unsupported transforms, controls and bounded work fail explicitly", () => {
  const base = {
    text: "abc",
    width: 5,
    widthMethod: "unicode",
    wrapMode: "word",
  } as const
  for (const overrides of [
    { conceal: true },
    { width: 0 },
    { firstLineOffset: 5 },
    { text: "a\r\nb" },
    { text: "\u001b[31mred" },
    { text: "\ud800" },
    { text: "\u0301" },
    { limits: { maxCodeUnits: 2 } },
    { limits: { maxGraphemes: 2 } },
    { text: "a\nb", limits: { maxRows: 1 } },
  ])
    expect(prepareTextLayout({ ...base, ...overrides }).status).toBe(
      "unsupported",
    )
})

test("word, character and unwrapped rows use distinct native wrap policies", () => {
  expect(
    ready("ab cd", { width: 4 }).rows.map((row) => row.startColumn),
  ).toEqual([0, 3])
  expect(
    ready("ab cd", { width: 4, wrapMode: "char" }).rows.map(
      (row) => row.startColumn,
    ),
  ).toEqual([0, 4])
  const unwrapped = ready("ab cd", { width: 4, wrapMode: "none", kind: "code" })
  expect(unwrapped.rowCount).toBe(1)
  expect(unwrapped.points[4]).toMatchObject({ column: 4, visible: false })
})

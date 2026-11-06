import { expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle, type TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { projectPlainText, type TranscriptItemBlock } from "@vimex/transcript"
import { prepareTextLayout } from "./prepared-text-layout"
import { compactPreparedTextLayout } from "./compact-prepared-text-layout"
import { prepareTextNavigation } from "./prepared-text-navigation"
import { measureRenderedBlock } from "./measure-rendered-block"

function blockFor(text: string): TranscriptItemBlock {
  const item = {
    id: itemId("prepared-navigation"),
    turnId: turnId("prepared-navigation"),
    kind: "assistant" as const,
    markdown: text,
    status: "complete" as const,
  }
  return {
    key: { kind: "item", itemId: item.id, blockId: "root" },
    turnId: item.turnId,
    item,
    renderItem: item,
    projection: { ...projectPlainText(text), revision: 1 },
    sourceSpan: { from: 0, to: text.length },
    contentRevision: 1,
    estimatedRows: 1,
    followedByActivity: false,
  }
}

const fixtures = [
  ["ASCII wrap and consumed whitespace", "alpha beta  gamma   delta tail"],
  ["wide and combining", "AéB界C🙂D👩‍💻E\nZéΩ終"],
  ["blank interior lines", "first\n\nthird\n\nlast"],
  ["trailing newline", "first\n\n"],
  ["leading blank lines", "\n\nthird\nlast"],
  ["only newline", "\n\n"],
  ["empty", ""],
  ["wide EOF", "end界"],
  ["clipped long line", "abcdefghijklmnopqrstuvwxyz0123456789"],
  ["whitespace only", "    \n    "],
] as const

for (const kind of ["plain", "code"] as const)
  for (const wrapMode of ["word", "char", "none"] as const)
    for (const [name, text] of fixtures)
      test(`prepared navigation ${kind} ${wrapMode} preserves measured ${name}`, async () => {
        const syntax = SyntaxStyle.create()
        const setup = await testRender(
          <box paddingLeft={3} paddingTop={2}>
            {kind === "plain" ? (
              <text id="native" content={text} width={13} wrapMode={wrapMode} />
            ) : (
              <code
                id="native"
                content={text}
                width={13}
                wrapMode={wrapMode}
                syntaxStyle={syntax}
                filetype="typescript"
                conceal={false}
                drawUnstyledText
              />
            )}
          </box>,
          { width: 40, height: 40 },
        )
        const native = setup.renderer.root.findDescendantById("native") as
          TextRenderable | CodeRenderable
        try {
          for (const width of [13, 7, 21]) {
            await act(async () => {
              native.width = width
              await setup.flush()
              await setup.renderOnce()
              if (native instanceof CodeRenderable)
                await native.highlightingDone
              await setup.flush()
              await setup.renderOnce()
            })
            const prepared = prepareTextLayout({
              text,
              width,
              widthMethod: setup.renderer.widthMethod,
              wrapMode,
              kind,
            })
            if (prepared.status !== "ready") throw new Error(prepared.reason)
            const compact = compactPreparedTextLayout(prepared.layout)
            const result = prepareTextNavigation(text, {
              ...compact,
              pointAt: (offset) => compact.point(offset),
            })
            if (result.status !== "ready") throw new Error(result.reason)
            const measured = measureRenderedBlock({
              renderer: setup.renderer,
              renderable: native,
              block: blockFor(text),
              width,
              styleRevision: "test",
              folded: false,
            })
            expect(result.navigation.rowCount).toBe(measured.rows)
            const mapped = Array.from(
              { length: compact.graphemeCount + 1 },
              (_, offset) => result.navigation.pointAt(offset),
            )
            expect(mapped).toEqual(
              Array.from({ length: compact.graphemeCount + 1 }, (_, offset) => {
                const point = measured.points[offset]
                return (
                  point && {
                    graphemeOffset: point.graphemeOffset,
                    row: point.row,
                    column: point.column,
                  }
                )
              }),
            )
            expect(result.navigation.pointAt(-1)).toBeUndefined()
            expect(
              result.navigation.pointAt(compact.graphemeCount + 1),
            ).toBeUndefined()
          }
        } finally {
          await act(async () => setup.renderer.destroy())
          syntax.destroy()
        }
      })

test("prepared navigation explicitly refuses legacy width disagreement and offsets", () => {
  for (const [text, firstLineOffset] of [
    ["a\tb", 0],
    ["text", 2],
  ] as const) {
    const prepared = prepareTextLayout({
      text,
      width: 13,
      widthMethod: "unicode",
      wrapMode: "word",
      firstLineOffset,
    })
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const compact = compactPreparedTextLayout(prepared.layout)
    expect(
      prepareTextNavigation(text, {
        ...compact,
        pointAt: (offset) => compact.point(offset),
      }),
    ).toEqual({
      status: "unsupported",
      reason: firstLineOffset
        ? "first-line-offset-policy"
        : "legacy-cell-width-mismatch",
    })
  }
})

test("compatibility boundaries preserve current cursor policy rather than native insertion ends", () => {
  const cases = [
    [
      "a\nb",
      [
        [0, 0],
        [1, 0],
        [1, 0],
        [1, 1],
      ],
    ],
    [
      "a\n\n",
      [
        [0, 0],
        [0, 0],
        [0, 1],
        [0, 1],
      ],
    ],
    [
      "界",
      [
        [0, 0],
        [0, 1],
      ],
    ],
    ["", [[0, 0]]],
    ["\n\n", [undefined, undefined, undefined]],
  ] as const
  for (const [text, expected] of cases) {
    const prepared = prepareTextLayout({
      text,
      width: 13,
      widthMethod: "unicode",
      wrapMode: "word",
    })
    if (prepared.status !== "ready") throw new Error(prepared.reason)
    const compact = compactPreparedTextLayout(prepared.layout)
    const result = prepareTextNavigation(text, {
      ...compact,
      pointAt: (offset) => compact.point(offset),
    })
    if (result.status !== "ready") throw new Error(result.reason)
    expect(
      Array.from({ length: compact.graphemeCount + 1 }, (_, offset) => {
        const point = result.navigation.pointAt(offset)
        if (point) expect(Object.isFrozen(point)).toBe(true)
        return point && [point.row, point.column]
      }),
    ).toEqual(expected.map((point) => point && [...point]))
    expect(result.navigation.pointAt(0.5)).toBeUndefined()
    expect(result.navigation.boundaryPayloadBytes).toBeLessThanOrEqual(
      text.split("\n").length * 24,
    )
  }
})

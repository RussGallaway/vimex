import { expect, test } from "bun:test"
import {
  CodeRenderable,
  OptimizedBuffer,
  Selection,
  RGBA,
  SyntaxStyle,
  type TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { prepareTextLayout } from "./prepared-text-layout"

const cases = [
  ["ASCII", "alpha beta gamma delta\nnext row"],
  ["combining and wide glyphs", "AéB界C🙂D👩‍💻E\nZéΩ終"],
  ["tabs", "a\tb\tc\n\tindent\nx\t"],
  ["blank lines and trailing newline", "first\n\nthird\n"],
  ["only blank lines", "\n\n"],
  [
    "long word and whitespace wrap",
    "aSuperLongUnbrokenIdentifier123456789  tail   word\n   indented text",
  ],
  ["empty", ""],
] as const

// These tests deliberately do not reconstruct wrapping or character widths.
// Mounted native renderables supply line geometry, native hit-testing supplies
// source text, and a crop of the real painted buffer supplies cell contents.
for (const kind of ["plain", "code"] as const) {
  for (const wrapMode of ["word", "char", "none"] as const) {
    for (const [name, text] of cases) {
      test(`prepared ${kind} ${wrapMode} matches mounted native ${name}, including resize`, async () => {
        const syntax = SyntaxStyle.create()
        const setup = await testRender(
          kind === "plain" ? (
            <text
              id="native-oracle"
              content={text}
              width={13}
              wrapMode={wrapMode}
            />
          ) : (
            <code
              id="native-oracle"
              content={text}
              width={13}
              wrapMode={wrapMode}
              syntaxStyle={syntax}
              filetype="typescript"
              conceal={false}
              drawUnstyledText
            />
          ),
          { width: 32, height: 32 },
        )
        const native = setup.renderer.root.findDescendantById(
          "native-oracle",
        ) as TextRenderable | CodeRenderable
        const parts = [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            text,
          ),
        ].map((part) => part.segment)
        const crops = new Map<number, OptimizedBuffer>()
        try {
          for (const width of [13, 7, 21]) {
            await act(async () => {
              native.onSelectionChanged(null)
              native.width = width
              await setup.flush()
              await setup.renderOnce()
              if (native instanceof CodeRenderable)
                await native.highlightingDone
              await setup.flush()
              await setup.renderOnce()
            })
            const result = prepareTextLayout({
              text,
              width,
              wrapMode,
              kind,
              widthMethod: setup.renderer.widthMethod,
            })
            expect(result.status).toBe("ready")
            if (result.status !== "ready") throw new Error(result.reason)
            const { layout } = result
            const info = native.lineInfo
            expect(native.plainText).toBe(text)
            expect(layout.rowCount).toBe(info.lineStartCols.length)
            expect(layout.rows.map((row) => row.startColumn)).toEqual(
              info.lineStartCols,
            )
            expect(layout.rows.map((row) => row.width)).toEqual(
              info.lineWidthCols,
            )
            expect(layout.rows.map((row) => row.sourceLine)).toEqual(
              info.lineSources,
            )
            expect(layout.graphemeCount).toBe(parts.length)
            expect(layout.points.map((point) => point.graphemeOffset)).toEqual(
              Array.from({ length: parts.length + 1 }, (_, i) => i),
            )
            for (const point of layout.points) {
              const source = parts[point.graphemeOffset]
              if (source === undefined || source === "\n") {
                expect(point.kind).toBe(
                  source === undefined ? "end" : "newline",
                )
                expect(point.visible).toBe(false)
                continue // Insertion/newline boundaries are not painted cells.
              }
              if (!point.visible) continue
              const x = native.x + point.column
              const y = native.y + point.row
              if (source.trim() && point.column + point.width <= width) {
                const fromX = point.column > 0 ? x - 1 : x
                const toX = point.column > 0 ? x : x + 1
                const selection = new Selection(
                  native,
                  { x: fromX, y },
                  { x: toX, y },
                )
                selection.isStart = true
                native.onSelectionChanged(selection)
                const selected = native.getSelectedText()
                expect(
                  point.column > 0
                    ? selected.endsWith(source)
                    : selected.startsWith(source),
                ).toBe(true)
              }
              if (point.column + point.width > width) continue // Native clipping cannot paint a partial wide glyph.
              const cropWidth = Math.min(point.width, width - point.column)
              let crop = crops.get(cropWidth)
              if (!crop) {
                crop = OptimizedBuffer.create(
                  cropWidth,
                  1,
                  setup.renderer.widthMethod,
                )
                crops.set(cropWidth, crop)
              }
              crop.clear(RGBA.fromHex("#000000"))
              crop.drawFrameBuffer(
                0,
                0,
                setup.renderer.currentRenderBuffer,
                x,
                y,
                cropWidth,
                1,
              )
              const painted = new TextDecoder().decode(crop.getRealCharBytes())
              expect({ width, point, painted }).toEqual({
                width,
                point,
                painted: source === "\t" ? " ".repeat(cropWidth) : source,
              })
            }
            // Completeness oracle: inspect native painted cells, not adapter
            // visibility. Every nonblank native cell must be covered, including
            // the continuation cells of wide glyphs. This catches an adapter
            // that silently hides difficult clusters instead of mapping them.
            const buffer = setup.renderer.currentRenderBuffer
            for (let row = 0; row < native.height; row++) {
              for (let column = 0; column < width; column++) {
                const cell =
                  buffer.buffers.char[
                    (native.y + row) * buffer.width + native.x + column
                  ]!
                if (cell === 0 || cell === 32) continue
                expect(
                  layout.points.some(
                    (point) =>
                      point.visible &&
                      point.row === row &&
                      column >= point.column &&
                      column < point.column + point.width,
                  ),
                ).toBe(true)
              }
            }
          }
        } finally {
          for (const crop of crops.values()) crop.destroy()
          await act(async () => {
            setup.renderer.destroy()
          })
          syntax.destroy()
        }
      })
    }
  }
}

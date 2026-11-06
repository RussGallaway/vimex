import { expect, test } from "bun:test"
import {
  CodeRenderable,
  OptimizedBuffer,
  RGBA,
  Selection,
  SyntaxStyle,
  type TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { prepareCompactTextLayout } from "./compact-prepared-text-layout"
import { prepareTextViewport } from "./prepared-text-viewport"

const fixtures = [
  ["ASCII wrapped", "alpha beta gamma delta\nnext row and final words"],
  ["Unicode", "AéB界C🙂D👩‍💻E\nZéΩ終"],
  ["blank rows", "first\n\nthird\n"],
  ["all blank", "\n\n"],
  [
    "long whitespace wraps",
    "aSuperLongUnbrokenIdentifier123456789  tail   word\n   indented text",
  ],
  ["empty", ""],
] as const

for (const kind of ["plain", "code"] as const)
  for (const wrapMode of ["word", "char", "none"] as const)
    for (const [name, text] of fixtures)
      test(`prepared viewport ${kind}/${wrapMode} paints native ${name} through scrolling and resize`, async () => {
        const syntax = SyntaxStyle.create()
        const setup = await testRender(
          <box>
            {kind === "plain" ? (
              <text id="oracle" content={text} width={13} wrapMode={wrapMode} />
            ) : (
              <code
                id="oracle"
                content={text}
                width={13}
                wrapMode={wrapMode}
                filetype="typescript"
                syntaxStyle={syntax}
                conceal={false}
                drawUnstyledText
              />
            )}
            <text
              id="viewport"
              position="absolute"
              left={32}
              top={0}
              width={13}
              height={3}
              wrapMode="none"
              content=""
            />
          </box>,
          { width: 64, height: 32 },
        )
        const native = setup.renderer.root.findDescendantById("oracle") as
          TextRenderable | CodeRenderable
        const painted = setup.renderer.root.findDescendantById(
          "viewport",
        ) as TextRenderable
        try {
          for (const width of [13, 7, 21]) {
            await act(async () => {
              native.width = width
              painted.width = width
              await setup.flush()
              await setup.renderOnce()
              if (native instanceof CodeRenderable)
                await native.highlightingDone
              await setup.flush()
              await setup.renderOnce()
            })
            const compact = prepareCompactTextLayout({
              text,
              width,
              widthMethod: setup.renderer.widthMethod,
              wrapMode,
              kind,
            })
            if (compact.status !== "ready") throw new Error(compact.reason)
            const result = prepareTextViewport(text, compact.layout)
            // Nonwrapping Unicode can intersect a viewport edge halfway through
            // a wide glyph. That geometry is an explicit fallback, not parity.
            if (result.status === "unsupported") {
              expect(wrapMode).toBe("none")
              expect(name).toBe("Unicode")
              expect(result.reason).toBe("partial-cell-clipping")
              continue
            }
            const crop = OptimizedBuffer.create(
              width,
              1,
              setup.renderer.widthMethod,
            )
            const snapshot = (x: number, y: number) => {
              crop.clear(RGBA.fromHex("#000000"))
              crop.drawFrameBuffer(
                0,
                0,
                setup.renderer.currentRenderBuffer,
                x,
                y,
                width,
                1,
              )
              return new TextDecoder().decode(crop.getRealCharBytes())
            }
            try {
              // Descending starts exercise reversal; every row enters view.
              const starts = Array.from(
                { length: compact.layout.rowCount },
                (_, i) => i,
              )
              for (const start of [...starts, ...starts.toReversed()]) {
                const rows = result.viewport.rows(start, 3)
                await act(async () => {
                  painted.content = rows.map((row) => row.text).join("\n")
                  await setup.flush()
                  await setup.renderOnce()
                })
                for (let index = 0; index < rows.length; index++) {
                  expect({
                    width,
                    start,
                    index,
                    text: snapshot(painted.x, painted.y + index),
                  }).toEqual({
                    width,
                    start,
                    index,
                    text: snapshot(native.x, native.y + start + index),
                  })
                }
                // Clearing a previously full viewport must not leave stale rows.
                for (let index = rows.length; index < 3; index++)
                  expect(snapshot(painted.x, painted.y + index)).toBe(
                    " ".repeat(width),
                  )
              }
            } finally {
              crop.destroy()
            }
          }
        } finally {
          await act(async () => setup.renderer.destroy())
          syntax.destroy()
        }
      })

test("viewport explicitly refuses tabs, offsets and split wide glyphs", () => {
  for (const input of [
    { text: "a\tb", width: 8, firstLineOffset: 0, reason: "tab-paint-policy" },
    {
      text: "abc",
      width: 8,
      firstLineOffset: 1,
      reason: "first-line-offset-policy",
    },
    {
      text: "a界",
      width: 2,
      firstLineOffset: 0,
      reason: "partial-cell-clipping",
    },
  ]) {
    const compact = prepareCompactTextLayout({
      ...input,
      widthMethod: "unicode",
      wrapMode: "none",
    })
    if (compact.status !== "ready") throw new Error(compact.reason)
    expect(prepareTextViewport(input.text, compact.layout)).toEqual({
      status: "unsupported",
      reason: input.reason,
    })
  }
})

test("viewport indexes source once and bounds rows without exposing mutable data", () => {
  const compact = prepareCompactTextLayout({
    text: "a界\nb",
    width: 8,
    widthMethod: "unicode",
    wrapMode: "word",
  })
  if (compact.status !== "ready") throw new Error(compact.reason)
  const result = prepareTextViewport("a界\nb", compact.layout)
  if (result.status !== "ready") throw new Error(result.reason)
  expect(result.viewport.sourceIndexBytes).toBe(40)
  expect(result.viewport.sourceCodeUnits).toBe(4)
  expect(result.viewport.rows(1, 100)).toEqual([{ row: 1, text: "b" }])
  expect(result.viewport.rows(99, 1)).toEqual([])
  expect(Object.isFrozen(result.viewport.rows(0, 1)[0])).toBe(true)
  expect(() => result.viewport.rows(-1, 1)).toThrow()
  expect(() => result.viewport.rows(0, 1.5)).toThrow()
  expect(prepareTextViewport("a", compact.layout)).toEqual({
    status: "unsupported",
    reason: "source-length-mismatch",
  })
})

test("visible cross-row selection paints the same native backgrounds after cropping", async () => {
  const text = "zero\nalpha beta gamma delta\n界wide text last"
  const width = 13
  const compact = prepareCompactTextLayout({
    text,
    width,
    widthMethod: "unicode",
    wrapMode: "word",
  })
  if (compact.status !== "ready") throw new Error(compact.reason)
  const result = prepareTextViewport(text, compact.layout)
  if (result.status !== "ready") throw new Error(result.reason)
  const rows = result.viewport.rows(1, 3)
  const setup = await testRender(
    <box>
      <text
        id="original"
        content={text}
        width={width}
        wrapMode="word"
        selectionBg="#663399"
      />
      <text
        id="cropped"
        position="absolute"
        left={20}
        top={0}
        content={rows.map((row) => row.text).join("\n")}
        width={width}
        height={3}
        wrapMode="none"
        selectionBg="#663399"
      />
    </box>,
    { width: 40, height: 12 },
  )
  const original = setup.renderer.root.findDescendantById(
    "original",
  ) as TextRenderable
  const cropped = setup.renderer.root.findDescendantById(
    "cropped",
  ) as TextRenderable
  const crop = OptimizedBuffer.create(width, 3, setup.renderer.widthMethod)
  const snapshot = (x: number, y: number) => {
    crop.clear(RGBA.fromHex("#000000"))
    crop.drawFrameBuffer(
      0,
      0,
      setup.renderer.currentRenderBuffer,
      x,
      y,
      width,
      3,
    )
    return {
      text: new TextDecoder().decode(crop.getRealCharBytes()),
      background: Array.from(crop.buffers.bg),
    }
  }
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const before = snapshot(cropped.x, cropped.y)
    await act(async () => {
      for (const [native, startRow] of [
        [original, 1],
        [cropped, 0],
      ] as const) {
        const selection = new Selection(
          native,
          { x: native.x + 2, y: native.y + startRow },
          { x: native.x + 5, y: native.y + startRow + 1 },
        )
        selection.isStart = true
        native.onSelectionChanged(selection)
      }
      await setup.flush()
      await setup.renderOnce()
    })
    const after = snapshot(cropped.x, cropped.y)
    expect(after.background).not.toEqual(before.background)
    expect(after).toEqual(snapshot(original.x, original.y + 1))
  } finally {
    crop.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

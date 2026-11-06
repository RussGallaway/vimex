import { expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle, type TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import {
  graphemes,
  projectPlainText,
  type LogicalPoint,
  type TranscriptItemBlock,
} from "@vimex/transcript"
import { measureRenderedBlock } from "./measure-rendered-block"
import { movePoint, type TranscriptLayout } from "./layout"
import { PreparedViewportExperiment } from "./prepared-viewport-experiment"

function settle(controller: PreparedViewportExperiment) {
  for (let i = 0; i < 100; i++) {
    controller.advance()
    const frame = controller.frame()
    if (frame.status === "fallback") throw new Error(frame.fallbackReason)
    if (frame.status === "ready" && frame.pending === 0) return frame
    controller.prepare()
  }
  throw new Error("Experiment did not settle")
}

for (const kind of ["plain", "code"] as const)
  for (const width of [7, 13, 21])
    for (const [name, phrase] of [
      ["wrapped ASCII", "alpha beta  gamma delta tail and more ordinary words"],
      ["wrapped Unicode", "AéB界C🙂D👩‍💻E and 界面 words with wide characters"],
    ] as const)
      test(`prepared controller ${kind} ${width} agrees with mounted movePoint for ${name}`, async () => {
        const text = [phrase, phrase, phrase].join("\n")
        const id = itemId("fixture")
        const item = {
          id,
          turnId: turnId("fixture"),
          kind: "assistant" as const,
          markdown: text,
          status: "complete" as const,
        }
        const block: TranscriptItemBlock = {
          key: { kind: "item", itemId: id, blockId: "root" },
          turnId: item.turnId,
          item,
          renderItem: item,
          projection: { ...projectPlainText(text), revision: 1 },
          sourceSpan: { from: 0, to: text.length },
          contentRevision: 1,
          estimatedRows: 1,
          followedByActivity: false,
        }
        const syntax = SyntaxStyle.create()
        const setup = await testRender(
          kind === "plain" ? (
            <text id="oracle" content={text} width={width} wrapMode="word" />
          ) : (
            <code
              id="oracle"
              content={text}
              width={width}
              wrapMode="word"
              syntaxStyle={syntax}
              filetype="typescript"
              conceal={false}
              drawUnstyledText
            />
          ),
          { width: 30, height: 100 },
        )
        try {
          const native = setup.renderer.root.findDescendantById("oracle") as
            TextRenderable | CodeRenderable
          await act(async () => {
            await setup.flush()
            await setup.renderOnce()
            if (native instanceof CodeRenderable) await native.highlightingDone
            await setup.flush()
            await setup.renderOnce()
          })
          const geometry = measureRenderedBlock({
            renderer: setup.renderer,
            renderable: native,
            block,
            width,
            styleRevision: "oracle",
            folded: false,
          })
          const lines = geometry.lines.map((line) => ({ ...line, itemId: id }))
          const layout: TranscriptLayout = {
            width,
            lines,
            linesByItem: { [id]: lines },
            points: {
              [id]: Object.fromEntries(
                Object.entries(geometry.points).map(([offset, point]) => [
                  offset,
                  {
                    itemId: id,
                    graphemeOffset: point.graphemeOffset,
                    row: point.row,
                    column: point.column,
                    screenX: point.x,
                    screenY: point.y,
                  },
                ]),
              ),
            },
          }
          const controller = new PreparedViewportExperiment({
            blocks: [{ id, text, kind }],
            width,
            height: 3,
          })
          settle(controller)
          controller.beginSelection()
          let oracle: LogicalPoint = { itemId: id, graphemeOffset: 0 }
          for (const delta of [1, 2, -1, 2, -3, 1]) {
            for (let step = 0; step < Math.abs(delta); step++)
              oracle = movePoint(
                layout,
                oracle,
                delta > 0 ? "down" : "up",
              )!.point
            expect(controller.enqueue(delta)).toBe(true)
            const frame = settle(controller)
            expect(controller.state.cursor).toEqual(oracle)
            const measured = geometry.points[oracle.graphemeOffset]!
            expect(frame.top?.row).toBe(measured.row)
            expect(frame.cursor).toEqual({ x: measured.column, y: 0 })
            expect(controller.copy()).toBe(
              graphemes(text)
                .slice(0, oracle.graphemeOffset + 1)
                .join(""),
            )
          }
        } finally {
          await act(async () => setup.renderer.destroy())
          syntax.destroy()
        }
      })

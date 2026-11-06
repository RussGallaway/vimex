import { expect, test } from "bun:test"
import { act } from "react"
import { itemId, turnId } from "@vimex/conversation"
import { thread, wheelHarness } from "./scroll-continuity-harness"
import { subscribeNavigationTrace, type NavigationTraceRecord } from "./trace"

type Harness = Awaited<ReturnType<typeof wheelHarness>>
function kitty(h: Harness, key: "u" | "d", type: 1 | 2 | 3, ctrl = true) {
  h.renderer.stdin.emit(
    "data",
    Buffer.from(`\x1b[${key.charCodeAt(0)};${ctrl ? 5 : 1}:${type}u`),
  )
}
async function fixture(
  enabled: boolean,
  run: (h: Harness, records: NavigationTraceRecord[]) => Promise<void>,
) {
  const previous = process.env.VIMEX_NAV_REPEAT_CONTROL
  process.env.VIMEX_NAV_REPEAT_CONTROL = enabled ? "1" : "0"
  const h = await wheelHarness(100)
  const records: NavigationTraceRecord[] = []
  const unsubscribe = subscribeNavigationTrace(h.renderer, (event) =>
    records.push(event),
  )
  try {
    await run(h, records)
  } finally {
    unsubscribe()
    await h.close()
    if (previous === undefined) delete process.env.VIMEX_NAV_REPEAT_CONTROL
    else process.env.VIMEX_NAV_REPEAT_CONTROL = previous
  }
}
function lastQueue(records: NavigationTraceRecord[]) {
  const record = records.findLast(
    (event) =>
      event.kind === "intent.enqueued" || event.kind === "intent.repeat-pruned",
  )!
  return record.details.pendingRows as {
    rows: number
    repeatKey?: string
    sequence: number
  }[]
}

test("confirmed repeats are bounded and modifier-free release removes pending movement", async () => {
  await fixture(true, async (h, records) => {
    await act(async () => {
      kitty(h, "u", 1)
      for (let i = 0; i < 20; i++) kitty(h, "u", 2)
      expect(lastQueue(records)).toHaveLength(2)
      expect(
        lastQueue(records).filter((intent) => intent.repeatKey === "u"),
      ).toHaveLength(1)
      kitty(h, "u", 3, false)
      expect(lastQueue(records)).toHaveLength(1)
      expect(lastQueue(records)[0]!.repeatKey).toBeUndefined()
      await h.flush()
    })
  })
})

test("reversal supersedes old repeats but preserves the deliberate initial press", async () => {
  await fixture(true, async (h, records) => {
    await act(async () => {
      kitty(h, "u", 1)
      for (let i = 0; i < 8; i++) kitty(h, "u", 2)
      kitty(h, "d", 1)
      expect(
        lastQueue(records).map((intent) => Math.sign(intent.rows)),
      ).toEqual([-1, 1])
      expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(true)
      await h.flush()
    })
  })
})

for (const enabled of [false, true])
  test(`legacy deliberate bursts remain exact with experiment ${enabled}`, async () => {
    await fixture(enabled, async (h, records) => {
      await act(async () => {
        for (let i = 0; i < 8; i++) h.mockInput.pressKey("u", { ctrl: true })
        expect(lastQueue(records)).toHaveLength(8)
        expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(
          true,
        )
        await h.flush()
      })
    })
  })

test("flag off preserves every enhanced-protocol repeat", async () => {
  await fixture(false, async (h, records) => {
    await act(async () => {
      kitty(h, "u", 1)
      for (let i = 0; i < 8; i++) kitty(h, "u", 2)
      kitty(h, "u", 3)
      expect(lastQueue(records)).toHaveLength(9)
      expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(true)
      await h.flush()
    })
  })
})

test("explicit counted holds and Visual holds retain exact navigation", async () => {
  await fixture(true, async (h, records) => {
    await act(async () => {
      h.controller.dispatchInteraction({ type: "mode.normal" })
      h.controller.dispatchInteraction({
        type: "focus.set",
        surface: "transcript",
      })
      await h.flush()
    })
    await act(async () => {
      await h.mockInput.typeText("3")
      kitty(h, "u", 1)
      for (let i = 0; i < 8; i++) kitty(h, "u", 2)
      kitty(h, "u", 3)
      expect(lastQueue(records)).toHaveLength(9)
      expect(lastQueue(records)[0]!.rows).toBe(-3)
      expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(true)
      await h.flush()
    })
    await h.keys("v")
    expect(h.workspace().interaction.mode).toBe("visual")
    records.length = 0
    await act(async () => {
      kitty(h, "u", 1)
      for (let i = 0; i < 8; i++) kitty(h, "u", 2)
      kitty(h, "u", 3)
      expect(lastQueue(records)).toHaveLength(9)
      expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(true)
      await h.flush()
    })
  })
})

test("context changes clear pending repeats without discarding deliberate navigation", async () => {
  await fixture(true, async (h, records) => {
    await act(async () => {
      kitty(h, "u", 1)
      kitty(h, "u", 2)
      h.controller.dispatchInteraction({
        type: "overlay.open",
        overlay: "help",
      })
    })
    expect(records.some((event) => event.kind === "intent.repeat-pruned")).toBe(
      true,
    )
  })
})

test("distinct enhanced-protocol presses are never coalesced", async () => {
  await fixture(true, async (h, records) => {
    await act(async () => {
      for (let i = 0; i < 8; i++) {
        kitty(h, "u", 1)
        kitty(h, "u", 3)
      }
      expect(lastQueue(records)).toHaveLength(8)
      expect(lastQueue(records).every((intent) => !intent.repeatKey)).toBe(true)
      await h.flush()
    })
  })
})

for (const focus of ["composer", "transcript"] as const)
  for (const input of ["key", "wheel"] as const)
    test(`stopped partial repeat cannot consume opposite ${input} with ${focus} focus`, async () => {
      await fixture(true, async (h, records) => {
        await act(async () => {
          for (let i = 0; i < 20; i++)
            h.emit({
              type: "conversation",
              event: {
                type: "item.started",
                threadId: thread,
                item: {
                  id: itemId(`partial-markdown-${i}`),
                  turnId: turnId("wheel-turn"),
                  kind: "assistant",
                  markdown: Array.from(
                    { length: 72 },
                    (_, n) =>
                      `Paragraph ${n}: ${"measured scrollback content ".repeat(3)}[source](https://vimex.test/${n}).`,
                  ).join("\n\n"),
                  status: "complete",
                },
              },
            })
          await h.controller.settle()
          await h.flush({ maxPasses: 400 })
          h.controller.dispatchInteraction({ type: "mode.normal" })
          h.controller.dispatchInteraction({
            type: "focus.set",
            surface: focus,
          })
          await h.flush()
        })
        let partial: number | undefined
        const repeats = new Set<number>()
        let injected = false
        let stopped: number | undefined
        let injectedAt = 0
        let baseline: string | undefined
        let injection: Promise<void> | undefined
        const stop = subscribeNavigationTrace(h.renderer, (event) => {
          const details = event.details as {
            sequence?: number
            remaining?: number
            intent?: { sequence?: number; repeatKey?: string }
          }
          if (event.kind === "row.begin" && details.intent?.repeatKey)
            repeats.add(details.intent.sequence!)
          if (
            event.kind === "row.step" &&
            details.sequence !== undefined &&
            repeats.has(details.sequence)
          )
            partial = details.remaining ? details.sequence : undefined
          if (event.kind === "intent.resolved" && details.sequence === partial)
            partial = undefined
          if (
            event.kind !== "prepare.complete" ||
            partial === undefined ||
            injected
          )
            return
          injected = true
          stopped = partial
          injection = new Promise<void>((resolve) =>
            queueMicrotask(() => {
              baseline = JSON.stringify(h.workspace().transcript.viewport)
              injectedAt = performance.now()
              kitty(h, "u", 3)
              if (input === "key") {
                h.mockInput.pressKey("e", { ctrl: true })
                resolve()
              } else {
                const scroll = h.renderer.root.findDescendantById(
                  "transcript",
                ) as import("@opentui/core").ScrollBoxRenderable
                void h.mockMouse
                  .scroll(
                    scroll.viewport.screenX + 10,
                    scroll.viewport.screenY + 3,
                    "down",
                  )
                  .then(resolve)
              }
            }),
          )
        })
        try {
          await act(async () => {
            kitty(h, "u", 1)
            for (let i = 0; i < 300 && !injected; i++) {
              kitty(h, "u", 2)
              await Bun.sleep(5)
            }
            await injection
            await h.flush({ maxPasses: 400 })
          })
          expect(injected).toBe(true)
          expect(
            records.filter(
              (event) =>
                event.kind === "intent.repeat-truncated" &&
                event.atMs < injectedAt,
            ),
          ).toHaveLength(0)
          expect(
            records.some(
              (event) =>
                event.kind === "intent.repeat-truncated" &&
                event.details.sequence === stopped,
            ),
          ).toBe(true)
          expect(
            records.filter(
              (event) =>
                event.atMs > injectedAt &&
                event.kind === "row.step" &&
                event.details.sequence === stopped,
            ),
          ).toHaveLength(0)
          expect(
            records.some(
              (event) =>
                event.atMs > injectedAt &&
                event.kind === "row.step" &&
                Number(event.details.requested) > 0,
            ),
          ).toBe(true)
          expect(JSON.stringify(h.workspace().transcript.viewport)).not.toBe(
            baseline,
          )
          expect(h.workspace().interaction.surface).toBe(focus)
        } finally {
          stop()
        }
      })
    }, 30000)

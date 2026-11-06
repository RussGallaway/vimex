import { expect, test } from "bun:test"
import { act } from "react"
import { wheelHarness } from "./scroll-continuity-harness"
import {
  subscribeNavigationTrace,
  type NavigationTraceRecord,
} from "./navigation-trace"

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

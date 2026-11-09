import { expect, test } from "bun:test"
import { threadId, turnId, type ThreadSummary } from "@vimex/conversation"
import type { WorkbenchLifecycleSnapshot } from "@vimex/workbench"
import { RexIntegration } from "./rex-integration"

const summary: ThreadSummary = {
  id: threadId("thread-one"),
  title: "Fix login redirect",
  cwd: "/tmp/repo",
  model: "fixture-model",
  reasoningEffort: "high",
  status: "idle",
}

function snapshot(
  patch: Partial<WorkbenchLifecycleSnapshot> = {},
): WorkbenchLifecycleSnapshot {
  return {
    summary,
    connection: "connected",
    pendingApprovals: 0,
    ...patch,
  }
}

function turn(
  status: NonNullable<WorkbenchLifecycleSnapshot["turn"]>["status"],
  id = "turn-one",
) {
  return { id: turnId(id), status }
}

function harness(enabled = true) {
  const records: string[] = []
  const titles: string[] = []
  const reporter = new RexIntegration({
    enabled,
    write: (sequence) => {
      records.push(sequence)
    },
    setTitle: (title) => {
      titles.push(title)
    },
  })
  return { reporter, records, titles }
}

function fields(sequence: string): Record<string, string> {
  expect(sequence.startsWith("\x1b]7501;")).toBe(true)
  expect(sequence.endsWith("\x1b\\")).toBe(true)
  return Object.fromEntries(
    sequence
      .slice(7, -2)
      .split(":")
      .map((pair) => {
        const index = pair.indexOf("=")
        return [pair.slice(0, index), pair.slice(index + 1)]
      }),
  )
}

test("disabled integration never writes status or terminal titles", () => {
  const { reporter, records, titles } = harness(false)
  reporter.report(snapshot({ turn: turn("running"), pendingApprovals: 1 }))
  reporter.dispose()
  expect(records).toEqual([])
  expect(titles).toEqual([])
})

test("reports working, approval and question blocks, then resumes", () => {
  const { reporter, records, titles } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(
    snapshot({
      turn: turn("running"),
      pendingApprovals: 1,
      pendingQuestions: 1,
    }),
  )
  reporter.report(snapshot({ turn: turn("running"), pendingQuestions: 1 }))
  reporter.report(snapshot({ turn: turn("running") }))
  const reports = records.map(fields)
  expect(reports.map((report) => report.state)).toEqual([
    "working",
    "blocked",
    "blocked",
    "working",
  ])
  expect(reports[1]?.kind).toBe("permission")
  expect(reports[2]?.kind).toBe("question")
  expect(reports[3]?.kind).toBeUndefined()
  expect(reports.every((report) => report.app === "vimex")).toBe(true)
  expect(Buffer.from(reports[1]!.msg!, "base64").toString()).toBe(
    "Approval required",
  )
  expect(titles).toEqual(["Vimex · Fix login redirect"])
})

for (const [status, expected] of [
  ["complete", "done"],
  ["failed", "error"],
  ["interrupted", "idle"],
] as const) {
  test(`same running turn becoming ${status} reports ${expected}`, () => {
    const { reporter, records } = harness()
    reporter.report(snapshot({ turn: turn("running") }))
    reporter.report(snapshot({ turn: turn(status) }))
    expect(records.map((record) => fields(record).state)).toEqual([
      "working",
      expected,
    ])
  })
}

test("opening or switching to an already completed thread does not announce completion", () => {
  const { reporter, records } = harness()
  reporter.report(snapshot({ turn: turn("complete") }))
  expect(fields(records.at(-1)!).state).toBe("idle")
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(
    snapshot({
      summary: { ...summary, id: threadId("thread-two") },
      turn: turn("complete"),
    }),
  )
  expect(fields(records.at(-1)!).state).toBe("idle")
  reporter.report(snapshot({ turn: turn("complete", "turn-two") }))
  expect(fields(records.at(-1)!).state).toBe("idle")
})

test("interrupted turn stays idle even if the summary still says working", () => {
  const { reporter, records } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(
    snapshot({
      turn: turn("interrupted"),
      summary: { ...summary, status: "working" },
    }),
  )
  expect(fields(records.at(-1)!).state).toBe("idle")
})

test("completion stays visible through metadata updates until the next turn", () => {
  const { reporter, records, titles } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(snapshot({ turn: turn("complete") }))
  reporter.report(
    snapshot({
      turn: turn("complete"),
      summary: { ...summary, title: "Renamed", contextUsed: 10 },
    }),
  )
  expect(records.map((record) => fields(record).state)).toEqual([
    "working",
    "done",
  ])
  expect(titles.at(-1)).toBe("Vimex · Renamed")
  reporter.report(snapshot({ turn: turn("running", "turn-two") }))
  expect(fields(records.at(-1)!).state).toBe("working")
})

test("connection loss clears sticky completion and pending attention", () => {
  const { reporter, records } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(snapshot({ turn: turn("complete") }))
  reporter.report(
    snapshot({
      turn: turn("complete"),
      connection: "disconnected",
      pendingApprovals: 1,
    }),
  )
  expect(fields(records.at(-1)!).state).toBe("idle")
  reporter.report(snapshot({ turn: turn("complete") }))
  expect(fields(records.at(-1)!).state).toBe("idle")
})

test("deduplicates unchanged state and title despite metadata updates", () => {
  const { reporter, records, titles } = harness()
  reporter.report(snapshot())
  reporter.report(snapshot())
  reporter.report(
    snapshot({ summary: { ...summary, model: "other", contextUsed: 200 } }),
  )
  expect(records).toHaveLength(1)
  expect(titles).toHaveLength(1)
})

test("terminal titles remove controls, bidi overrides, and excess whitespace", () => {
  const { reporter, titles } = harness()
  reporter.report(
    snapshot({
      summary: {
        ...summary,
        title: "  fix\nlogin\t\x1b]2;evil\x07 \u009b \u202e redirect\u2069  ",
      },
    }),
  )
  const title = titles[0]!
  expect(title).toBe("Vimex · fix login ]2;evil redirect")
  expect(title).not.toMatch(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u,
  )
})

test("terminal titles bound UTF-8 bytes without splitting code points", () => {
  const { reporter, titles } = harness()
  reporter.report(
    snapshot({ summary: { ...summary, title: "🙂".repeat(100) } }),
  )
  const title = titles[0]!
  expect(Buffer.byteLength(title)).toBeLessThanOrEqual(192)
  expect(title).toBe("Vimex · " + "🙂".repeat(40))
  reporter.report(snapshot({ summary: { ...summary, title: "\n\t" } }))
  expect(titles.at(-1)).toBe("Vimex")
})

test("dispose clears once and ignores later lifecycle updates", () => {
  const { reporter, records, titles } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.dispose()
  reporter.dispose()
  reporter.report(snapshot())
  expect(records.map((record) => fields(record).state)).toEqual([
    "working",
    "clear",
  ])
  expect(titles).toEqual(["Vimex · Fix login redirect", ""])
})

test("failed status writes can be retried without losing completion", () => {
  const records: string[] = []
  let fail = false
  const reporter = new RexIntegration({
    enabled: true,
    write(sequence) {
      if (fail) throw new Error("output unavailable")
      records.push(sequence)
    },
    setTitle() {},
  })
  reporter.report(snapshot({ turn: turn("running") }))
  fail = true
  expect(() => reporter.report(snapshot({ turn: turn("complete") }))).toThrow(
    "output unavailable",
  )
  fail = false
  reporter.report(snapshot({ turn: turn("complete") }))
  expect(records.map((record) => fields(record).state)).toEqual([
    "working",
    "done",
  ])
})

test("failed title updates retry and do not publish a partial report", () => {
  let fail = true
  const records: string[] = []
  const titles: string[] = []
  const reporter = new RexIntegration({
    enabled: true,
    write: (sequence) => {
      records.push(sequence)
    },
    setTitle(title) {
      if (fail) throw new Error("title unavailable")
      titles.push(title)
    },
  })
  expect(() => reporter.report(snapshot())).toThrow("title unavailable")
  expect(records).toHaveLength(0)
  fail = false
  reporter.report(snapshot())
  expect(records).toHaveLength(1)
  expect(titles).toEqual(["Vimex · Fix login redirect"])
})

test("dispose still resets the title when clearing fails", () => {
  const titles: string[] = []
  const reporter = new RexIntegration({
    enabled: true,
    write() {
      throw new Error("clear failed")
    },
    setTitle: (title) => {
      titles.push(title)
    },
  })
  expect(() => reporter.dispose()).toThrow("clear failed")
  reporter.dispose()
  expect(titles).toEqual([""])
})

test("server blocked state is honored without a local request", () => {
  const { reporter, records } = harness()
  reporter.report(
    snapshot({
      turn: turn("running"),
      summary: { ...summary, status: "blocked" },
    }),
  )
  expect(fields(records.at(-1)!).state).toBe("blocked")
  expect(fields(records.at(-1)!).kind).toBeUndefined()
})

test("completion during disconnection is not announced on reconnect", () => {
  const { reporter, records } = harness()
  reporter.report(snapshot({ turn: turn("running") }))
  reporter.report(
    snapshot({ turn: turn("running"), connection: "disconnected" }),
  )
  reporter.report(snapshot({ turn: turn("complete") }))
  expect(fields(records.at(-1)!).state).toBe("idle")
})

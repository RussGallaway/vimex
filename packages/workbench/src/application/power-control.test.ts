import { expect, test } from "bun:test"
import { needsLocalWakefulness } from "./power-control"
import type { WorkbenchState } from "./workbench-state"

test("wakefulness includes sent local submissions and side turns but not queued or remote work", () => {
  const workspace = (activeTurnId?: string, status?: string) => ({
    conversation: { activeTurnId },
    composer: { outbox: status ? [{ status }] : [] },
  })
  const state = (workspaces: unknown, extra = {}) =>
    ({
      machine: { id: "local" },
      connection: "connected",
      workspaces,
      ...extra,
    }) as WorkbenchState
  expect(
    needsLocalWakefulness(state({ main: workspace(undefined, "queued") })),
  ).toBe(false)
  expect(
    needsLocalWakefulness(state({ main: workspace(undefined, "sending") })),
  ).toBe(true)
  expect(
    needsLocalWakefulness(
      state({ main: workspace(), side: workspace("turn") }),
    ),
  ).toBe(true)
  expect(
    needsLocalWakefulness(
      state({ main: { ...workspace(), pendingSubmissions: [{}] } }),
    ),
  ).toBe(true)
  expect(
    needsLocalWakefulness(
      state({ main: workspace("turn") }, { machine: { id: "devbox" } }),
    ),
  ).toBe(false)
  expect(
    needsLocalWakefulness(
      state({ main: workspace("turn") }, { connection: "disconnected" }),
    ),
  ).toBe(false)
  expect(
    needsLocalWakefulness(
      state({ main: workspace("turn") }, { machineChanging: true }),
    ),
  ).toBe(false)
})

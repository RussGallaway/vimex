import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FatalBoundary } from "./FatalBoundary"

function Broken(): never { throw new Error("fatal render fixture") }

test("reports a descendant render failure to the application lifecycle", async () => {
  const failures: Error[] = []
  const setup = await testRender(<FatalBoundary onFatal={error => failures.push(error)}><Broken /></FatalBoundary>, { width: 40, height: 10 })
  try {
    await act(async () => setup.flush())
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe("fatal render fixture")
  } finally {
    await act(async () => setup.renderer.destroy())
  }
})

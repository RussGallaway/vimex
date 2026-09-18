import { describe, expect, test } from "bun:test"
import { formulaAction, publicationAction } from "../../scripts/release/policy"

describe("release publication policy", () => {
  test("creates a missing release, resumes a draft, and reuses published assets", () => {
    expect(publicationAction("missing")).toBe("create")
    expect(publicationAction("draft")).toBe("resume")
    expect(publicationAction("published")).toBe("reuse")
  })

  test("rejects an unknown state instead of choosing a destructive default", () => {
    expect(() => publicationAction("unknown" as never)).toThrow("Unknown publication state")
  })
})

describe("formula deployment policy", () => {
  test("deploys only the latest stable release", () => {
    expect(formulaAction("v0.1.2", "v0.1.2")).toBe("deploy")
    expect(formulaAction("v0.1.1", "v0.1.2")).toBe("skip-superseded")
    expect(formulaAction("v0.2.0-rc.1", "v0.1.2")).toBe("skip-prerelease")
  })
})

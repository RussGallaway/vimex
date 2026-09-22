import { expect, test } from "bun:test"
import { upgrade } from "./upgrade"
import { diagnose } from "./diagnose"
import { parseRelease, normalizeVersion } from "../domain/release"
import type { DistributionPorts } from "./distribution-ports"
import type { Installation } from "../domain/installation"
const release = {
  version: "0.2.0",
  artifacts: [
    {
      platform: "darwin" as const,
      arch: "arm64" as const,
      name: "vimex-v0.2.0-darwin-arm64.tar.gz",
      sha256: "a".repeat(64),
    },
  ],
}
function harness(installation: Installation) {
  const calls: string[] = []
  const ports: DistributionPorts = {
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    installation: async () => installation,
    releases: {
      get: async (version) => {
        calls.push(`release ${version ?? "latest"}`)
        return release
      },
    },
    install: async () => {
      calls.push("install")
    },
    homebrewUpgrade: async () => {
      calls.push("brew")
    },
    diagnostics: async () => [],
  }
  return { calls, ports }
}
test("source and unknown installations are never downloaded or overwritten", async () => {
  for (const kind of ["source", "unknown"] as const) {
    const h = harness({ kind })
    expect((await upgrade(h.ports)).status).toBe("instructions")
    expect(h.calls).toEqual([])
  }
})
test("Homebrew ownership delegates upgrade without directly replacing files", async () => {
  const h = harness({ kind: "homebrew" })
  expect((await upgrade(h.ports)).status).toBe("updated")
  expect(h.calls).toEqual(["brew"])
  expect((await upgrade(h.ports, "0.2.0")).status).toBe("instructions")
  expect(h.calls).toEqual(["brew"])
})
test("direct updates select target and surface post-commit warnings; unsupported target is not installed", async () => {
  const h = harness({
    kind: "direct",
    root: "/owned",
    executable: "/owned/current/vimex",
    version: "0.1.0",
  })
  expect((await upgrade(h.ports, "v0.2.0")).status).toBe("updated")
  expect(h.calls).toEqual(["release 0.2.0", "install"])
  h.ports.currentVersion = "0.2.0"
  expect((await upgrade(h.ports)).status).toBe("current")
  h.ports.currentVersion = "0.1.0"
  h.ports.install = async () => ({ warning: "receipt warning" })
  expect((await upgrade(h.ports)).message).toContain("receipt warning")
  h.ports.platform = "win32"
  await expect(upgrade(h.ports)).rejects.toThrow("No Vimex")
})
test("manifest and requested-version validation reject traversal and duplicate artifacts", () => {
  expect(parseRelease(release)).toEqual(release)
  expect(() => normalizeVersion("../../main")).toThrow()
  expect(() =>
    parseRelease({
      ...release,
      artifacts: [{ ...release.artifacts[0], name: "../vimex.tar.gz" }],
    }),
  ).toThrow()
  expect(() =>
    parseRelease({
      ...release,
      artifacts: [release.artifacts[0], release.artifacts[0]],
    }),
  ).toThrow()
})
test("doctor errors fail health checks while warnings remain informative", async () => {
  expect(
    (
      await diagnose({
        diagnostics: async () => [
          { name: "TTY", status: "warning", detail: "headless" },
        ],
      })
    ).healthy,
  ).toBe(true)
  expect(
    (
      await diagnose({
        diagnostics: async () => [
          { name: "Codex", status: "error", detail: "not found" },
        ],
      })
    ).healthy,
  ).toBe(false)
})

test("latest never downgrades a newer installed version but explicit pins can", async () => {
  const h = harness({
    kind: "direct",
    root: "/owned",
    executable: "/owned/current/vimex",
    version: "1.0.0",
  })
  h.ports.currentVersion = "1.0.0"
  const latest = await upgrade(h.ports)
  expect(latest.status).toBe("current")
  expect(latest.message).toContain("keeping the installed version")
  expect(h.calls).toEqual(["release latest"])
  expect((await upgrade(h.ports, "0.2.0")).status).toBe("updated")
  expect(h.calls).toEqual(["release latest", "release 0.2.0", "install"])
  h.ports.currentVersion = "0.2.0-rc.1"
  expect((await upgrade(h.ports)).status).toBe("updated")
})

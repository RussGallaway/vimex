import { expect, test } from "bun:test"
import { compareVersions, normalizeVersion } from "./release"

test("release versions enforce SemVer numeric and prerelease identifiers", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha.0",
    "1.2.3-rc-01",
    "1.2.3-0alpha",
    "1.2.3--",
    "100000000000000000000.0.0",
  ])
    expect(normalizeVersion(`v${version}`)).toBe(version)
  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-alpha.01",
    "1.2.3-",
    "1.2.3-alpha..1",
    "1.2.3-.alpha",
    "1.2.3-alpha.",
    "1.2.3-alpha_beta",
    "1.2",
    "1.2.3 ",
  ])
    expect(() => normalizeVersion(version)).toThrow("Invalid release version")
  expect(() => normalizeVersion("1.2.3+build.1")).toThrow(
    "Build metadata is not supported",
  )
})
test("version precedence compares core numbers and SemVer prereleases without precision loss", () => {
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "9007199254740992.0.0",
    "9007199254740993.0.0",
  ]
  for (let index = 0; index < versions.length - 1; index++) {
    expect(compareVersions(versions[index]!, versions[index + 1]!)).toBe(-1)
    expect(compareVersions(versions[index + 1]!, versions[index]!)).toBe(1)
    expect(compareVersions(versions[index]!, `v${versions[index]}`)).toBe(0)
  }
  expect(
    compareVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993"),
  ).toBe(-1)
})

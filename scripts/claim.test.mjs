import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const fixtures = []
afterEach(() => {
  for (const root of fixtures.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vimex-claims-"))
  fixtures.push(root)
  fs.mkdirSync(path.join(root, "scripts"))
  const script = path.join(root, "scripts/claim.mjs")
  fs.copyFileSync(new URL("./claim.mjs", import.meta.url), script)
  return { root, script, registry: path.join(root, ".vimex/coordination") }
}
function run(f, ...args) {
  return spawnSync(process.execPath, [f.script, ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  })
}
function acquire(f, id, ...scopes) {
  return run(
    f,
    "acquire",
    "--id",
    id,
    "--owner",
    "test-agent",
    ...scopes.flatMap((scope) => ["--scope", scope]),
  )
}
function json(result) {
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

test("scopes conflict in both directions, allow siblings, and acquire atomically", () => {
  const f = fixture()
  json(acquire(f, "one", "packages/a"))
  for (const scope of [
    "packages/a",
    "packages/a/src",
    "packages",
    ".",
    "PACKAGES/A",
  ]) {
    expect(acquire(f, "two", "free", scope).status).toBe(1)
  }
  expect(json(run(f, "list", "--json")).map((c) => c.id)).toEqual(["one"])
  json(acquire(f, "sibling", "packages/ab", "packages/b"))
  const whole = fixture()
  json(acquire(whole, "all", "."))
  expect(acquire(whole, "child", "new/file").status).toBe(1)
})

test("verification and release require current token and covered scopes", () => {
  const f = fixture()
  const first = json(acquire(f, "task", "src"))
  expect(run(f, "verify", "--id", "task").status).toBe(1)
  expect(
    run(
      f,
      "verify",
      "--id",
      "task",
      "--claim-id",
      first.claimId,
      "--scope",
      "src/new",
    ).status,
  ).toBe(0)
  expect(
    run(
      f,
      "verify",
      "--id",
      "task",
      "--claim-id",
      first.claimId,
      "--scope",
      "other",
    ).status,
  ).toBe(1)
  expect(run(f, "release", "--id", "task", "--claim-id", "wrong").status).toBe(
    1,
  )
  expect(
    run(f, "release", "--id", "task", "--claim-id", first.claimId).status,
  ).toBe(0)
  const next = json(acquire(f, "task", "src"))
  expect(next.claimId).not.toBe(first.claimId)
  expect(
    run(f, "release", "--id", "task", "--claim-id", first.claimId).status,
  ).toBe(1)
  expect(run(f, "release", "--id", "task", "--force").status).toBe(1)
  expect(
    run(
      f,
      "release",
      "--id",
      "task",
      "--force",
      "--reason",
      "confirmed abandoned",
    ).status,
  ).toBe(0)
})

test("strict flags, reserved paths, traversal, globs, and symlink aliases fail", () => {
  const f = fixture()
  for (const scope of [
    "../escape",
    "/absolute",
    ".git",
    ".GIT/config",
    ".vimex/claims",
    "src/*",
    "src/?",
    "src/[a]",
    "a/../b",
  ]) {
    expect(acquire(f, "invalid", scope).status).toBe(1)
  }
  fs.mkdirSync(path.join(f.root, "real"))
  fs.symlinkSync("real", path.join(f.root, "alias"))
  expect(acquire(f, "alias", "alias/new").status).toBe(1)
  expect(run(f, "list", "--typo").status).toBe(1)
  expect(run(f, "list", "--json", "--json").status).toBe(1)
  expect(acquire(f, "empty").status).toBe(1)
})

test("busy and damaged registries fail closed without stealing or deleting claims", () => {
  const f = fixture()
  const claim = json(acquire(f, "task", "src"))
  const lock = path.join(f.registry, "registry.lock")
  fs.mkdirSync(lock)
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    '{"pid":999999,"createdAt":"2000-01-01"}',
  )
  expect(acquire(f, "other", "other").stderr).toContain("registry is busy")
  expect(fs.existsSync(lock)).toBe(true)
  fs.rmSync(lock, { recursive: true })
  fs.writeFileSync(path.join(f.registry, "claims/task.json"), "{}")
  expect(acquire(f, "other", "other").stderr).toContain("malformed claim")
  expect(fs.existsSync(lock)).toBe(false)
  fs.writeFileSync(
    path.join(f.registry, "claims/task.json"),
    JSON.stringify(claim),
  )
  fs.writeFileSync(path.join(f.registry, "claims/interrupted.tmp"), "partial")
  expect(json(run(f, "list", "--json"))).toHaveLength(1)
})

test("independent processes competing for one scope produce exactly one owner", async () => {
  const f = fixture()
  const children = Array.from({ length: 10 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        f.script,
        "acquire",
        "--id",
        `task-${i}`,
        "--owner",
        `agent-${i}`,
        "--scope",
        "shared",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  )
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })),
  )
  expect(results.filter((r) => r.code === 0)).toHaveLength(1)
  for (const result of results.filter((r) => r.code !== 0)) {
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/overlaps claim|registry is busy/)
  }
  expect(json(run(f, "list", "--json"))).toHaveLength(1)
  expect(fs.existsSync(path.join(f.registry, "registry.lock"))).toBe(false)
})

test("registry is checkout-local, independent of cwd, and ignored by repository rules", () => {
  const first = fixture(),
    second = fixture()
  const claim = json(acquire(first, "one", "src"))
  expect(claim.repositoryRoot).toBe(fs.realpathSync(first.root))
  json(acquire(second, "two", "src"))
  expect(json(run(first, "list", "--json"))).toHaveLength(1)
  fs.copyFileSync(
    new URL("../.gitignore", import.meta.url),
    path.join(first.root, ".gitignore"),
  )
  expect(spawnSync("git", ["init", "-q", first.root]).status).toBe(0)
  expect(
    spawnSync("git", ["check-ignore", ".vimex/coordination/claims/one.json"], {
      cwd: first.root,
    }).status,
  ).toBe(0)
})

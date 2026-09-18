import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const root = resolve(import.meta.dir, "../..")
let directory: string
let config: string
let trace: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "vimex-cli-headless-"))
  const bin = join(directory, "bin")
  await mkdir(bin)
  trace = join(directory, "codex-calls")
  const executable = join(bin, "codex")
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VIMEX_TEST_CODEX_TRACE"\nif [ "$1" = "--version" ]; then printf "codex-cli 0.154.0\\n"; exit 0; fi\nprintf "Unexpected Codex invocation\\n" >&2\nexit 99\n')
  await chmod(executable, 0o755)
  config = join(directory, "config.json")
  await writeFile(config, JSON.stringify({ codexExecutable: executable }))
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function cli(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, join(root, "apps/cli/src/main.ts"), ...args], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TERM: "xterm-256color", HERDR_ENV: "0", XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory, VIMEX_TEST_CODEX_TRACE: trace },
  })
  const timeout = setTimeout(() => child.kill(), 8_000)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const output = stdout + stderr
    expect(output).not.toContain("\x1b[?1049h")
    expect(output).not.toContain("\x1b[?1047h")
    expect(output).not.toContain("\x1b[?1000h")
    return { stdout, stderr, code }
  } finally { clearTimeout(timeout) }
}

test("CLI help and version work outside the repository without initializing a terminal", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await cli(args)
    expect(result.code).toBe(0)
    expect(result.stdout.toLowerCase()).toContain("usage")
    expect(result.stdout).toContain("resume")
    expect(result.stdout).toContain("doctor")
  }
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version
  for (const args of [["--version"], ["-V"]]) {
    const result = await cli(args)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`vimex ${version}`)
  }
})

test("CLI invalid arguments reject headlessly instead of launching a blank TUI", async () => {
  for (const args of [["definitely-not-a-vimex-command"], ["--unknown"], ["resume", "--unknown"], ["--cwd"]]) {
    const result = await cli(args)
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  }
})

test("CLI doctor probes runtime health without creating or resuming a conversation", async () => {
  const result = await cli(["doctor", "--config", config])
  if (result.code !== 0) throw new Error(`Doctor failed: ${result.stderr}\n${result.stdout}`)
  expect(result.stdout.toLowerCase()).toContain("codex")
  const calls = (await readFile(trace, "utf8")).trim().split("\n")
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(call => call === "--version")).toBe(true)
})

test("source update and upgrade produce identical ownership-safe instructions", async () => {
  const update = await cli(["update"])
  const upgrade = await cli(["upgrade"])
  expect(update.code).toBe(0)
  expect(upgrade.code).toBe(0)
  expect(update.stdout).toBe(upgrade.stdout)
  expect(update.stdout.toLowerCase()).toContain("source")
})

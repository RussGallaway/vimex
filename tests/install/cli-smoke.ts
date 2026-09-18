/** Run against a freshly installed executable, from an unrelated working directory. */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { version } from "../../package.json"
const executable = process.argv[2]
if (!executable) throw new Error("Usage: bun tests/install/cli-smoke.ts /absolute/path/to/vimex")
const binary = resolve(executable)
const cwd = await mkdtemp(join(tmpdir(), "vimex-installed-cli-"))
const checks: string[] = []
try {
  const codex = join(cwd, "fake-codex"), trace = join(cwd, "codex-trace"), config = join(cwd, "config.json")
  await writeFile(codex, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VIMEX_TEST_CODEX_TRACE"\nif [ "$1" = "--version" ]; then printf "codex-cli 0.154.0\\n"; exit 0; fi\nexit 99\n')
  await chmod(codex, 0o755)
  await writeFile(config, JSON.stringify({ codexExecutable: codex }))
  for (const args of [["--help"], ["--version"], ["doctor", "--config", config], ["--unknown-option"]]) {
    const child = Bun.spawn([binary, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_ENV: "0", XDG_CONFIG_HOME: cwd, XDG_STATE_HOME: cwd, VIMEX_TEST_CODEX_TRACE: trace } })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if ((stdout + stderr).includes("\x1b[?1049h")) throw new Error(`${args[0]} initialized the alternate screen`)
      if (args[0] === "--unknown-option") { if (code === 0 || !stderr) throw new Error("Invalid option unexpectedly succeeded") }
      else {
        if (code !== 0) throw new Error(`${args[0]} failed: ${stderr}`)
        if (args[0] === "--help" && !stdout.toLowerCase().includes("usage")) throw new Error("Installed help missing")
        if (args[0] === "--version" && stdout.trim() !== `vimex ${version}`) throw new Error(`Unexpected version: ${stdout}`)
      }
      checks.push(args.join(" "))
    } finally { clearTimeout(timer) }
  }
  const calls = (await readFile(trace, "utf8")).trim().split("\n")
  if (!calls.length || calls.some(call => call !== "--version")) throw new Error("Doctor started a conversation")
  console.log(JSON.stringify({ passed: true, binary, checks }))
} finally { await rm(cwd, { recursive: true, force: true }) }

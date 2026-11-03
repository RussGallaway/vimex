import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { machineStdioOptions, quoteShell } from "./machine-transport"

test("SSH proxy resolves installed Codex on every connection without remote cwd as local cwd", () => {
  const options = machineStdioOptions("/remote/repo", {
    id: "devbox",
    sshHost: "devbox",
  })
  expect(options.command).toBe("ssh")
  expect(options.cwd).toBeUndefined()
  expect(options.args).toContain("BatchMode=yes")
  expect(options.args).toContain("ServerAliveCountMax=3")
  expect(options.args?.at(-1)).toContain("app-server daemon start")
  expect(options.args?.at(-1)).toContain("app-server proxy")
  expect(options.args?.at(-1)).toContain("app-server-daemon/current/bin/codex")
  expect(options.args?.at(-1)).not.toContain("daemon restart")
})

test("local daemon proxy and explicit fixture stdio have independent lifetimes", () => {
  const proxy = machineStdioOptions("/repo", { id: "local" })
  expect(proxy.command).toBe("sh")
  expect(proxy.args?.[1]).toContain("app-server proxy")
  expect(
    machineStdioOptions("/repo", {
      id: "local",
      mode: "stdio",
      executable: "/fixture",
    }),
  ).toEqual({ cwd: "/repo", command: "/fixture" })
})

test("shell quoting treats quotes, substitutions, and whitespace as data", () => {
  const payload = "a' $(echo injected) `echo injected`\n b"
  const result = execFileSync(
    "sh",
    ["-c", `printf '%s' ${quoteShell(payload)}`],
    { encoding: "utf8" },
  )
  expect(result).toBe(payload)
  expect(() => quoteShell("bad\0value")).toThrow()
  for (const sshHost of ["-oProxyCommand=bad", "host\ncommand", " host"])
    expect(() => machineStdioOptions("/repo", { id: "bad", sshHost })).toThrow()
})

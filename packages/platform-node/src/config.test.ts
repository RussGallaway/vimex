import { expect, test } from "bun:test"
import { parseConfig } from "./config"

test("machine config accepts explicit remote paths and transports", () => {
  const config = parseConfig({
    machines: {
      devbox: {
        sshHost: "devbox",
        label: "Travel VM",
        cwd: "~/CodeInbox/repo",
        codexExecutable: "codex",
      },
    },
    localTransport: "daemon",
  })
  expect(config.machines.devbox?.cwd).toBe("~/CodeInbox/repo")
  expect(config.machines.devbox?.label).toBe("Travel VM")
  expect(config.localTransport).toBe("daemon")
  expect(parseConfig({}).localTransport).toBe("auto")
})

test("machine config rejects ambiguous targets and unexpected settings", () => {
  for (const machines of [
    { devbox: { sshHost: "host", label: "" } },
    { devbox: { sshHost: "host", label: "a".repeat(81) } },
    { devbox: { sshHost: "host", label: "bad\u001b[31m" } },
    { devbox: { sshHost: "host", label: "bad\u009b" } },
    [],
    null,
    { local: { sshHost: "host" } },
    { "../host": { sshHost: "host" } },
    { devbox: { sshHost: "-oProxyCommand=bad" } },
    { devbox: { sshHost: "host;bad" } },
    { devbox: { sshHost: "host", extra: true } },
    { devbox: { sshHost: "host", cwd: "\u0000" } },
  ])
    expect(() => parseConfig({ machines })).toThrow()
  expect(() => parseConfig({ localTransport: "unknown" })).toThrow()
})

test("favorite machine config permits local and configured IDs only", () => {
  expect(parseConfig({}).favoriteMachines).toEqual([])
  expect(parseConfig({ favoriteMachines: ["local"] }).favoriteMachines).toEqual(
    ["local"],
  )
  expect(
    parseConfig({
      machines: { devbox: { sshHost: "devbox" } },
      favoriteMachines: ["devbox"],
    }).favoriteMachines,
  ).toEqual(["devbox"])
  for (const favoriteMachines of [
    null,
    {},
    [1],
    ["../bad"],
    ["missing"],
    ["local", "local"],
    ["constructor"],
  ])
    expect(() => parseConfig({ favoriteMachines })).toThrow("favoriteMachines")
})

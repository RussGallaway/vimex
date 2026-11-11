import { expect, test } from "bun:test"
import { verifyRexPane } from "./pane-verification"

const identity = {
  server: "unix:///a%20directory/rex.sock",
  session: "session:one",
  block: "block:one",
}
test("Rex verification accepts equivalent socket encoding and exact live IDs", async () => {
  await verifyRexPane(
    identity,
    async () => ({
      endpoint: "unix:///a directory/rex.sock",
      session_id: identity.session,
      block_id: identity.block,
    }),
    async () => ({ input: "/dev/ttys001", pane: "ttys001" }),
  )
})

test("valid inherited Rex IDs cannot adopt another PTY or a detached process", async () => {
  const inspect = async () => ({
    endpoint: identity.server,
    session_id: identity.session,
    block_id: identity.block,
  })
  for (const terminals of [
    { input: "/dev/ttys002", pane: "ttys001" },
    { input: "/dev/pts/2", pane: "pts/1" },
    { input: "not a tty", pane: "ttys001" },
    { input: "/dev/ttys001", pane: "??" },
    { input: "?", pane: "?" },
  ])
    await expect(
      verifyRexPane(identity, inspect, async () => terminals),
    ).rejects.toThrow("does not own this input terminal")
  await verifyRexPane(identity, inspect, async () => ({
    input: "/dev/pts/2",
    pane: "pts/2",
  }))
})
test("Rex verification rejects fallback servers and stale or foreign inherited IDs", async () => {
  const correct = {
    endpoint: identity.server,
    session_id: identity.session,
    block_id: identity.block,
  }
  for (const result of [
    null,
    { ...correct, endpoint: "unix:///another.sock" },
    { ...correct, session_id: undefined },
    { ...correct, block_id: "block:other" },
  ])
    await expect(verifyRexPane(identity, async () => result)).rejects.toThrow()
})

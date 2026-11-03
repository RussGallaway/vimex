import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAppServerClient } from "./capabilities/codex-app-server-client"
import type { CodexTransport, MessageListener } from "./transport/transport"
import { readRemoteText } from "./remote-workspace"

test("remote preview bounds read on server before transferring large file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vimex-bounded-read-"))
  const path = join(dir, "large file.txt")
  await writeFile(path, "x".repeat(1024 * 1024))
  let receive: MessageListener = () => {}
  let capturedBytes = 0
  const transport: CodexTransport = {
    start: async () => {},
    close: async () => {},
    onMessage(listener) {
      receive = listener
      return () => {}
    },
    onError() {
      return () => {}
    },
    onClose() {
      return () => {}
    },
    async send(message) {
      expect(message.method).toBe("command/exec")
      const params = message.params as {
        command: string[]
        outputBytesCap: number
      }
      const stdout = execFileSync(params.command[0]!, params.command.slice(1), {
        encoding: "utf8",
      })
      capturedBytes = Buffer.from(stdout, "base64").length
      expect(stdout.length).toBeLessThanOrEqual(params.outputBytesCap)
      receive({ id: message.id, result: { exitCode: 0, stdout, stderr: "" } })
    },
  }
  const client = new CodexAppServerClient(transport)
  try {
    expect(await readRemoteText(client, path, 4096)).toBeUndefined()
    expect(capturedBytes).toBe(4097)
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
})

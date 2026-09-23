import { expect, test } from "bun:test"
import type {
  CodexTransport,
  JsonObject,
  MessageListener,
} from "../transport/transport"
import { RpcClient } from "./json-rpc-client"

test("request sent callback follows successful transport write and cannot change RPC result", async () => {
  let finishWrite: (() => void) | undefined
  let receive: MessageListener = () => {}
  let sentId: number | undefined
  const transport: CodexTransport = {
    start: async () => {},
    send: (message: JsonObject) => {
      sentId = message.id as number
      return new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    },
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
  }
  const rpc = new RpcClient(transport)
  let sent = 0
  const response = rpc.request<string>("turn/start", {}, () => {
    sent++
    throw new Error("observer failure")
  })
  expect(sent).toBe(0)
  finishWrite?.()
  await Promise.resolve()
  expect(sent).toBe(1)
  receive({ id: sentId, result: "ok" })
  expect(await response).toBe("ok")
})

test("request sent callback does not run after failed transport write", async () => {
  const transport: CodexTransport = {
    start: async () => {},
    send: async () => {
      throw new Error("write failed")
    },
    close: async () => {},
    onMessage() {
      return () => {}
    },
    onError() {
      return () => {}
    },
    onClose() {
      return () => {}
    },
  }
  const rpc = new RpcClient(transport)
  let sent = false
  await expect(
    rpc.request("turn/start", {}, () => {
      sent = true
    }),
  ).rejects.toThrow("write failed")
  expect(sent).toBe(false)
})

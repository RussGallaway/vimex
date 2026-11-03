import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Duplex, PassThrough, Writable } from "node:stream"
import { createHash } from "node:crypto"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { WebSocketServer, type WebSocket } from "ws-node"
import { ProxyWebSocketTransport } from "./proxy-websocket-transport"

function processFixture() {
  const emitter = new EventEmitter()
  let kills = 0
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      kills++
      return true
    },
  })
  return {
    child,
    get kills() {
      return kills
    },
    factory: () => child as unknown as ChildProcessWithoutNullStreams,
  }
}
function serverFixture(
  options: { headers?: string[]; maxPayloadBytes?: number } = {},
) {
  const process = processFixture()
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  })
  const connected = Promise.withResolvers<WebSocket>()
  const frames: Buffer[] = []
  let upgrade = Buffer.alloc(0)
  let upgraded = false
  let requestLine = ""
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      process.child.stdout.write(chunk, callback)
    },
    final(callback) {
      process.child.stdout.end()
      callback()
    },
  })
  Object.assign(socket, { setTimeout() {}, setNoDelay() {} })
  server.on("headers", (headers) => headers.push(...(options.headers ?? [])))
  process.child.stdin.on("data", (chunk: Buffer) => {
    if (upgraded) {
      frames.push(Buffer.from(chunk))
      socket.push(chunk)
      return
    }
    upgrade = Buffer.concat([upgrade, chunk])
    const end = upgrade.indexOf("\r\n\r\n")
    if (end === -1) return
    const lines = upgrade.subarray(0, end).toString().split("\r\n")
    requestLine = lines.shift()!
    const request = new IncomingMessage(new Socket())
    request.method = "GET"
    request.url = "/rpc"
    request.headers = Object.fromEntries(
      lines.map((line) => {
        const index = line.indexOf(":")
        return [
          line.slice(0, index).toLowerCase(),
          line.slice(index + 1).trim(),
        ]
      }),
    )
    upgraded = true
    server.handleUpgrade(request, socket, Buffer.alloc(0), (client) => {
      client.on("error", () => {})
      connected.resolve(client)
    })
    if (upgrade.length > end + 4) socket.push(upgrade.subarray(end + 4))
  })
  const transport = new ProxyWebSocketTransport({
    command: "fixture-proxy",
    processFactory: process.factory,
    maxPayloadBytes: options.maxPayloadBytes,
  })
  return {
    process,
    transport,
    connected: connected.promise,
    frames,
    get requestLine() {
      return requestLine
    },
    async close() {
      await transport.close()
      socket.destroy()
      server.close()
    },
  }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test("proxy uses a real HTTP Upgrade, masked frames, fragmented UTF-8, and independent concurrent RPC messages", async () => {
  const h = serverFixture({
    headers: ["x-codex-websocket-max-unfragmented-message-bytes: 8"],
  })
  const received: unknown[] = []
  h.transport.onMessage((message) => received.push(message))
  try {
    await h.transport.start()
    const peer = await h.connected
    expect(h.requestLine).toBe("GET /rpc HTTP/1.1")
    const requests: unknown[] = []
    peer.on("message", (data) => requests.push(JSON.parse(data.toString())))
    await Promise.all([
      h.transport.send({ id: 1, method: "initialize", params: { text: "🌲" } }),
      h.transport.send({ id: 2, method: "model/list", params: {} }),
    ])
    await turn()
    await turn()
    expect(requests).toEqual([
      { id: 1, method: "initialize", params: { text: "🌲" } },
      { id: 2, method: "model/list", params: {} },
    ])
    expect(h.frames.length).toBeGreaterThan(2)
    const response = Buffer.from(JSON.stringify({ id: 1, result: "🌲" }))
    const split = response.indexOf(Buffer.from("🌲")) + 1
    peer.send(response.subarray(0, split), { binary: false, fin: false })
    peer.send(response.subarray(split), { binary: false, fin: true })
    const pong = Promise.withResolvers<string>()
    peer.on("pong", (data) => pong.resolve(data.toString()))
    peer.ping("alive")
    expect(await pong.promise).toBe("alive")
    await turn()
    expect(received).toEqual([{ id: 1, result: "🌲" }])
  } finally {
    await h.close()
  }
  expect(h.process.kills).toBeGreaterThan(0)
})

test("silent proxy handshake has its own deadline and close cancels startup", async () => {
  const process = processFixture()
  const transport = new ProxyWebSocketTransport({
    command: "silent",
    processFactory: process.factory,
    handshakeTimeoutMs: 15,
  })
  let closed = 0
  transport.onClose(() => closed++)
  await expect(transport.start()).rejects.toThrow("handshake timed out")
  expect(process.kills).toBeGreaterThan(0)
  expect(closed).toBe(1)
  await transport.close()
  expect(closed).toBe(1)
  const cancelled = processFixture()
  const other = new ProxyWebSocketTransport({
    command: "silent",
    processFactory: cancelled.factory,
  })
  const opening = other.start()
  await other.close()
  await expect(opening).rejects.toThrow("closed during initialization")
  expect(cancelled.kills).toBeGreaterThan(0)
})

test("invalid Upgrade responses and oversized headers fail before initialization", async () => {
  for (const response of [
    "HTTP/1.1 200 OK\r\n\r\n",
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
    "x".repeat(17 * 1024),
  ]) {
    const process = processFixture()
    const transport = new ProxyWebSocketTransport({
      command: "invalid",
      processFactory: process.factory,
    })
    const opening = transport.start()
    process.child.stdout.write(response)
    await expect(opening).rejects.toThrow()
    expect(process.kills).toBeGreaterThan(0)
    await transport.close()
  }
  const extensions = serverFixture({
    headers: ["Sec-WebSocket-Extensions: permessage-deflate"],
  })
  try {
    await expect(extensions.transport.start()).rejects.toThrow("unrequested")
  } finally {
    await extensions.close()
  }
})

test("frame protocol errors and payload limits close the proxy once", async () => {
  for (const mode of ["binary", "masked", "oversize"] as const) {
    const h = serverFixture({ maxPayloadBytes: 32 })
    const closed = Promise.withResolvers<Error | undefined>()
    let closeCount = 0
    h.transport.onClose((error) => {
      closeCount++
      closed.resolve(error)
    })
    try {
      await h.transport.start()
      const peer = await h.connected
      if (mode === "binary") peer.send(Buffer.from("{}"), { binary: true })
      else if (mode === "masked") peer.send("{}", { mask: true })
      else peer.send("x".repeat(64))
      expect(await closed.promise).toBeInstanceOf(Error)
      await expect(h.transport.send({ id: 1 })).rejects.toThrow("not open")
      expect(closeCount).toBe(1)
    } finally {
      await h.close()
    }
  }
})

test("server close rejects future sends and delivers the close reason", async () => {
  const h = serverFixture()
  const closed = Promise.withResolvers<Error | undefined>()
  h.transport.onClose((error) => closed.resolve(error))
  try {
    await h.transport.start()
    const peer = await h.connected
    peer.close(1001, "going away")
    const error = await closed.promise
    expect(error?.message).toContain("going away")
    await expect(h.transport.send({ id: 1 })).rejects.toThrow("not open")
  } finally {
    await h.close()
  }
})

test("last response drains before EOF or nonzero proxy exit is reported", async () => {
  for (const code of [0, 7]) {
    const h = serverFixture()
    const events: string[] = []
    const closed = Promise.withResolvers<void>()
    h.transport.onMessage((message) =>
      events.push(`response:${(message as { id: number }).id}`),
    )
    h.transport.onClose(() => {
      events.push("closed")
      closed.resolve()
    })
    try {
      await h.transport.start()
      const peer = await h.connected
      await new Promise<void>((resolve, reject) =>
        peer.send(JSON.stringify({ id: 7, result: "acknowledged" }), (error) =>
          error ? reject(error) : resolve(),
        ),
      )
      h.process.child.stdout.end()
      h.process.child.emit("close", code, null)
      await closed.promise
      expect(events).toEqual(["response:7", "closed"])
    } finally {
      await h.close()
    }
  }
})

test("failed pong write preserves an already received final RPC response", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    stdin: undefined as unknown as Writable,
  })
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!chunk.toString().startsWith("GET")) {
        callback(new Error("EPIPE"))
        return
      }
      const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(chunk.toString())![1]!
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64")
      const headers = Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      const response = Buffer.from(
        JSON.stringify({ id: 7, result: { accepted: true } }),
      )
      // Receiver defers ping and message callbacks. The pong hits a closed input,
      // but the response is already in our buffer and must reach RPC first.
      child.stdout.end(
        Buffer.concat([
          headers,
          Buffer.from([0x89, 0]),
          Buffer.from([0x81, response.length]),
          response,
        ]),
      )
      callback()
    },
  })
  const transport = new ProxyWebSocketTransport({
    command: "fixture-proxy",
    processFactory: () => child as unknown as ChildProcessWithoutNullStreams,
  })
  const events: string[] = []
  const closed = Promise.withResolvers<void>()
  transport.onMessage((message) => {
    expect(message).toEqual({ id: 7, result: { accepted: true } })
    events.push("response")
  })
  transport.onError((error) => events.push(error.message))
  transport.onClose(() => {
    events.push("close")
    closed.resolve()
  })
  try {
    await transport.start()
    await closed.promise
    expect(events).toEqual(["response", "EPIPE", "close"])
  } finally {
    await transport.close()
  }
})

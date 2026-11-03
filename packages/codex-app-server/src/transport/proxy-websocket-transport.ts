import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { Duplex, type Writable } from "node:stream"
import * as WebSocketCodec from "ws-node"
import type {
  CodexTransport,
  CloseListener,
  ErrorListener,
  JsonObject,
  MessageListener,
} from "./transport"

// ws publicly exports these codecs, but @types/ws only describes the higher-level client.
// The normal ws client depends on custom node:http connections, unsupported by Bun 1.3.6.
interface FrameSender {
  onerror: (error: Error) => void
  send(
    data: Buffer,
    options: {
      binary: boolean
      fin: boolean
      mask: boolean
      compress: boolean
    },
    callback: (error?: Error) => void,
  ): void
  pong(data: Buffer, mask: boolean, callback: (error?: Error) => void): void
  close(
    code: number | undefined,
    data: Buffer,
    mask: boolean,
    callback: (error?: Error) => void,
  ): void
}
const { Receiver, Sender } = WebSocketCodec as unknown as {
  Receiver: new (options: {
    isServer: boolean
    allowSynchronousEvents: boolean
    maxPayload: number
    maxBufferedChunks: number
    maxFragments: number
  }) => Writable
  Sender: new (stream: Duplex) => FrameSender
}

export interface ProxyWebSocketOptions {
  command: string
  args?: readonly string[]
  cwd?: string
  handshakeTimeoutMs?: number
  maxPayloadBytes?: number
  processFactory?: (
    command: string,
    args: readonly string[],
    cwd?: string,
  ) => ChildProcessWithoutNullStreams
}

/** HTTP Upgrade over a byte-forwarding proxy, then library-managed WebSocket framing. */
export class ProxyWebSocketTransport implements CodexTransport {
  private readonly messages = new Set<MessageListener>()
  private readonly errors = new Set<ErrorListener>()
  private readonly closes = new Set<CloseListener>()
  private child?: ChildProcessWithoutNullStreams
  private stream?: Duplex
  private receiver?: Writable
  private sender?: FrameSender
  private startup?: Promise<void>
  private resolveStartup?: () => void
  private rejectStartup?: (error: Error) => void
  private startupTimer?: ReturnType<typeof setTimeout>
  private closeTimer?: ReturnType<typeof setTimeout>
  private stderr = ""
  private header = Buffer.alloc(0)
  private expectedAccept = ""
  private closed = false
  private finished = false
  private opened = false
  private draining = false
  private drainError?: Error
  private failure?: Error
  private fragmentBytes = 16 * 1024 * 1024

  constructor(private readonly options: ProxyWebSocketOptions) {}

  start(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Codex proxy transport is closed"))
    if (this.startup) return this.startup
    this.startup = new Promise<void>((resolve, reject) => {
      this.resolveStartup = resolve
      this.rejectStartup = reject
      try {
        const key = randomBytes(16).toString("base64")
        this.expectedAccept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64")
        const stream = this.createProxyStream()
        stream.on("data", (chunk: Buffer) => this.accept(chunk))
        stream.on("error", (error) => this.drainBeforeDisconnect(error))
        stream.on("end", () => {
          if (!this.closed && !this.finished)
            this.drainBeforeDisconnect(
              this.drainError ?? new Error("Codex proxy closed its output"),
            )
        })
        this.startupTimer = setTimeout(
          () =>
            this.fail(new Error("Codex proxy WebSocket handshake timed out")),
          this.options.handshakeTimeoutMs ?? 30_000,
        )
        stream.write(
          `GET /rpc HTTP/1.1\r\nHost: codex-app-server\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          (error?: Error | null) => {
            if (error) this.fail(error)
          },
        )
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return this.startup
  }

  private createProxyStream(): Duplex {
    const factory =
      this.options.processFactory ??
      ((command, args, cwd) =>
        spawn(command, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }))
    const child = factory(
      this.options.command,
      this.options.args ?? [],
      this.options.cwd,
    )
    this.child = child
    const stream = new Duplex({
      read() {
        child.stdout.resume()
      },
      write(chunk, encoding, callback) {
        child.stdin.write(chunk, encoding, callback)
      },
      final(callback) {
        child.stdin.end(callback)
      },
      destroy(error, callback) {
        child.kill()
        callback(error)
      },
    })
    this.stream = stream
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stream.push(chunk)) child.stdout.pause()
    })
    child.stdout.on("end", () => stream.push(null))
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096)
    })
    child.stdin.on("error", (error) => stream.destroy(error))
    child.stdout.on("error", (error) => stream.destroy(error))
    child.on("error", (error) => stream.destroy(error))
    child.on("close", (code, signal) => {
      if (stream.destroyed) return
      if (code !== 0)
        this.drainError = new Error(
          `Codex proxy exited with code ${String(code)}${signal ? ` (${signal})` : ""}`,
        )
      // Process close follows stdout EOF. Ending (not destroying) preserves all
      // bytes queued in the Duplex and then drains Receiver before disconnect.
      stream.push(null)
    })
    return stream
  }

  private accept(chunk: Buffer): void {
    if (this.closed || this.finished || this.draining) return
    if (this.opened) {
      this.receiveFrames(chunk)
      return
    }
    this.header = Buffer.concat([this.header, chunk])
    const end = this.header.indexOf("\r\n\r\n")
    if (end === -1) {
      if (this.header.length > 16 * 1024)
        this.fail(
          new Error("Codex proxy WebSocket response headers are too large"),
        )
      return
    }
    if (end > 16 * 1024) {
      this.fail(
        new Error("Codex proxy WebSocket response headers are too large"),
      )
      return
    }
    try {
      const lines = this.header
        .subarray(0, end)
        .toString("latin1")
        .split("\r\n")
      if (!/^HTTP\/1\.1 101(?: |$)/.test(lines.shift() ?? ""))
        throw new Error("Codex proxy refused the WebSocket upgrade")
      const headers = new Map<string, string>()
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line)
        if (!match || /[\x00-\x08\x0a-\x1f\x7f]/.test(match[2]!))
          throw new Error("Invalid Codex proxy response header")
        const name = match[1]!.toLowerCase()
        if (headers.has(name))
          throw new Error(`Duplicate Codex proxy response header: ${name}`)
        headers.set(name, match[2]!.trim())
      }
      if (
        headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !headers
          .get("connection")
          ?.toLowerCase()
          .split(",")
          .map((part) => part.trim())
          .includes("upgrade") ||
        headers.get("sec-websocket-accept") !== this.expectedAccept
      )
        throw new Error("Invalid Codex proxy WebSocket upgrade response")
      if (
        headers.has("sec-websocket-extensions") ||
        headers.has("sec-websocket-protocol")
      )
        throw new Error(
          "Codex proxy selected an unrequested WebSocket extension or protocol",
        )
      const limit = Number(
        headers.get("x-codex-websocket-max-unfragmented-message-bytes"),
      )
      if (Number.isSafeInteger(limit) && limit > 0)
        this.fragmentBytes = Math.min(this.fragmentBytes, limit)
      this.sender = new Sender(this.stream!)
      this.sender.onerror = (error) => this.fail(error)
      const receiver = new Receiver({
        isServer: false,
        allowSynchronousEvents: false,
        maxPayload: this.options.maxPayloadBytes ?? 128 * 1024 * 1024,
        maxBufferedChunks: 65536,
        maxFragments: 65536,
      })
      this.receiver = receiver
      receiver.on("error", (error) => this.fail(error))
      receiver.on("drain", () => this.stream?.resume())
      receiver.on("message", (data: Buffer, binary: boolean) => {
        if (this.closed || this.finished) return
        try {
          if (binary)
            throw new Error("Codex proxy sent binary data instead of JSON text")
          const message: unknown = JSON.parse(data.toString("utf8"))
          for (const listener of this.messages) listener(message)
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      receiver.on("ping", (data: Buffer) =>
        this.sender?.pong(data, true, (error) => {
          if (error) this.drainBeforeDisconnect(error)
        }),
      )
      receiver.on("conclude", (code: number, reason: Buffer) => {
        this.opened = false
        this.closeTimer = setTimeout(() => this.finish(), 1000)
        if (!this.closed)
          this.failure = this.withStderr(
            new Error(
              `Codex proxy WebSocket closed (${code})${reason.length ? `: ${reason.toString()}` : ""}`,
            ),
          )
        this.sender?.close(code === 1005 ? undefined : code, reason, true, () =>
          this.finish(),
        )
      })
      this.opened = true
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
      this.resolveStartup?.()
      this.resolveStartup = undefined
      this.rejectStartup = undefined
      const remainder = this.header.subarray(end + 4)
      this.header = Buffer.alloc(0)
      if (remainder.length) this.receiveFrames(remainder)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private drainBeforeDisconnect(error: Error): void {
    if (this.closed || this.finished) return
    this.drainError = error
    if (this.draining) return
    const receiver = this.receiver
    if (!receiver || receiver.destroyed) {
      this.fail(error)
      return
    }
    this.draining = true
    this.opened = false
    // Receiver defers messages for input responsiveness. EOF must not discard an
    // already received RPC acknowledgment before publishing the disconnection.
    receiver.end(() => this.fail(this.drainError ?? error))
  }

  private receiveFrames(chunk: Buffer): void {
    if (!this.receiver?.write(chunk)) this.stream?.pause()
  }

  async send(message: JsonObject): Promise<void> {
    const sender = this.sender
    if (!sender || !this.opened || this.closed || this.finished)
      throw new Error("Codex proxy transport is not open")
    const payload = Buffer.from(JSON.stringify(message))
    // Queue every fragment synchronously, preventing concurrent RPCs from interleaving messages.
    await new Promise<void>((resolve, reject) => {
      for (
        let offset = 0;
        offset < payload.length;
        offset += this.fragmentBytes
      ) {
        const end = Math.min(payload.length, offset + this.fragmentBytes)
        sender.send(
          payload.subarray(offset, end),
          {
            binary: false,
            fin: end === payload.length,
            compress: false,
            mask: true,
          },
          (error) => {
            if (error) reject(error)
            else if (end === payload.length) resolve()
          },
        )
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.finish()
  }
  onMessage(listener: MessageListener): () => void {
    this.messages.add(listener)
    return () => {
      this.messages.delete(listener)
    }
  }
  onError(listener: ErrorListener): () => void {
    this.errors.add(listener)
    return () => {
      this.errors.delete(listener)
    }
  }
  onClose(listener: CloseListener): () => void {
    this.closes.add(listener)
    return () => {
      this.closes.delete(listener)
    }
  }
  private withStderr(error: Error): Error {
    const tail = this.stderr.trim()
    return tail
      ? new Error(`${error.message}: ${tail}`, { cause: error })
      : error
  }
  private fail(error: Error): void {
    if (this.closed || this.finished) return
    this.failure ??= this.withStderr(error)
    for (const listener of this.errors) listener(this.failure)
    this.finish()
  }
  private finish(): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.startupTimer)
    clearTimeout(this.closeTimer)
    this.startupTimer = undefined
    this.closeTimer = undefined
    this.receiver?.destroy()
    this.stream?.destroy()
    this.child?.kill()
    this.rejectStartup?.(
      this.failure ??
        new Error("Codex proxy connection closed during initialization"),
    )
    this.rejectStartup = undefined
    this.resolveStartup = undefined
    for (const listener of this.closes)
      listener(this.closed ? undefined : this.failure)
  }
}

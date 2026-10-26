import { spawn } from "node:child_process"

import type {
  CodexTransport,
  CloseListener,
  ErrorListener,
  JsonObject,
  MessageListener,
} from "./transport"

export interface StdioProcess {
  write(value: string): Promise<void>
  end(): void
  kill(): void
  onStdout(listener: (chunk: string | Uint8Array) => void): void
  onStderr(listener: (chunk: string | Uint8Array) => void): void
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number | null, signal: string | null) => void): void
}

export type StdioProcessFactory = (
  command: string,
  args: readonly string[],
  cwd?: string,
) => StdioProcess

function nodeProcessFactory(
  command: string,
  args: readonly string[],
  cwd?: string,
): StdioProcess {
  const child = spawn(command, [...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  })
  return {
    write(value) {
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(value, (error) => (error ? reject(error) : resolve()))
      })
    },
    end: () => child.stdin.end(),
    kill: () => child.kill(),
    onStdout: (listener) => child.stdout.on("data", listener),
    onStderr: (listener) => child.stderr.on("data", listener),
    onError: (listener) => child.on("error", listener),
    onExit: (listener) => child.on("exit", listener),
  }
}

export interface StdioTransportOptions {
  command?: string
  args?: readonly string[]
  cwd?: string
  processFactory?: StdioProcessFactory
  onStderr?: (text: string) => void
}

/** Newline-delimited app-server transport. It intentionally does not add a jsonrpc field. */
export class StdioTransport implements CodexTransport {
  private readonly messageListeners = new Set<MessageListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly closeListeners = new Set<CloseListener>()
  private process?: StdioProcess
  private buffer = ""
  private readonly decoder = new TextDecoder()
  private started = false
  private closed = false
  private finished = false
  private draining = false
  private drainTimer?: ReturnType<typeof setImmediate>
  private finishRequested?: { error?: Error }
  private readonly completion = Promise.withResolvers<void>()

  constructor(private readonly options: StdioTransportOptions = {}) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const factory = this.options.processFactory ?? nodeProcessFactory
    const process = factory(
      this.options.command ?? "codex",
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      this.options.cwd,
    )
    this.process = process
    process.onStdout((chunk) => this.acceptChunk(chunk))
    process.onStderr((chunk) => this.options.onStderr?.(decode(chunk)))
    process.onError((error) => this.emitError(error))
    process.onExit((code, signal) => {
      const error =
        this.closed || code === 0
          ? undefined
          : new Error(
              `codex app-server exited with code ${String(code)}${signal ? ` (${signal})` : ""}`,
            )
      this.finish(error)
    })
  }

  async send(message: JsonObject): Promise<void> {
    if (!this.process || this.closed)
      throw new Error("Codex transport is not open")
    await this.process.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    if (this.closed) return this.completion.promise
    this.closed = true
    this.process?.end()
    this.process?.kill()
    this.finish()
    await this.completion.promise
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  private acceptChunk(chunk: string | Uint8Array): void {
    if (this.finished || this.finishRequested) return
    this.buffer +=
      typeof chunk === "string"
        ? `${this.decoder.decode()}${chunk}`
        : this.decoder.decode(chunk, { stream: true })
    // A queued continuation owns the backlog. New stdout chunks must not jump
    // ahead of it and restart an unbounded run of synchronous event delivery.
    if (!this.drainTimer) this.drain()
  }

  private drain(): void {
    if (this.draining || this.finished) return
    this.draining = true
    const startedAt = performance.now()
    let delivered = 0
    try {
      while (true) {
        const newline = this.buffer.indexOf("\n")
        if (newline < 0) break
        // Bound both cheap-message bursts and expensive downstream callbacks.
        // Lifecycle shutdown deliberately drains its finite prefix before close.
        if (
          !this.finishRequested &&
          delivered > 0 &&
          (delivered >= 32 || performance.now() - startedAt >= 4)
        ) {
          this.drainTimer = setImmediate(() => {
            this.drainTimer = undefined
            this.drain()
          })
          break
        }
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        delivered++
        if (!line) continue
        try {
          const message: unknown = JSON.parse(line)
          for (const listener of this.messageListeners) listener(message)
        } catch (cause) {
          this.emitError(
            new Error(`Invalid JSONL from codex app-server: ${line}`, {
              cause,
            }),
          )
        }
      }
    } finally {
      this.draining = false
    }
    if (this.finishRequested) this.completeFinish()
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error)
      } catch {
        // Diagnostic observers must not strand queued messages or shutdown.
      }
    }
  }

  private finish(error?: Error): void {
    if (this.finished || this.finishRequested) return
    this.finishRequested = { error }
    if (this.drainTimer) clearImmediate(this.drainTimer)
    this.drainTimer = undefined
    this.buffer += this.decoder.decode()
    this.drain()
  }

  private completeFinish(): void {
    if (this.finished) return
    this.finished = true
    const finalLine = this.buffer.trim()
    if (finalLine) {
      try {
        const message: unknown = JSON.parse(finalLine)
        for (const listener of this.messageListeners) listener(message)
      } catch (cause) {
        this.emitError(
          new Error(
            `Invalid trailing JSONL from codex app-server: ${finalLine}`,
            { cause },
          ),
        )
      }
      this.buffer = ""
    }
    if (!this.closed) this.closed = true
    try {
      for (const listener of this.closeListeners)
        listener(this.finishRequested?.error)
    } finally {
      this.closeListeners.clear()
      this.completion.resolve()
    }
  }
}

function decode(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
}

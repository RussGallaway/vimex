export type JsonObject = Record<string, unknown>
export type MessageListener = (message: unknown) => void
export type ErrorListener = (error: Error) => void
export type CloseListener = (error?: Error) => void

/** Transport boundary for app-server JSON-RPC messages; each adapter owns its wire framing. */
export interface CodexTransport {
  start(): Promise<void>
  send(message: JsonObject): Promise<void>
  close(): Promise<void>
  onMessage(listener: MessageListener): () => void
  onError(listener: ErrorListener): () => void
  onClose(listener: CloseListener): () => void
}

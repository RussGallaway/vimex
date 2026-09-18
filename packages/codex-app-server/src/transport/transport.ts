export type JsonObject = Record<string, unknown>
export type MessageListener = (message: unknown) => void
export type ErrorListener = (error: Error) => void
export type CloseListener = (error?: Error) => void

/** Transport boundary for the app-server's newline-delimited JSON messages. */
export interface CodexTransport {
  start(): Promise<void>
  send(message: JsonObject): Promise<void>
  close(): Promise<void>
  onMessage(listener: MessageListener): () => void
  onError(listener: ErrorListener): () => void
  onClose(listener: CloseListener): () => void
}

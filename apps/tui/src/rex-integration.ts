import type { WorkbenchLifecycleSnapshot } from "@vimex/workbench"

interface RexIntegrationOptions {
  enabled: boolean
  write(sequence: string): void
  setTitle(title: string): void
}

type Status = "idle" | "working" | "blocked" | "done" | "error"

/** Reports the focused conversation, independently of the Codex transport. */
export class RexIntegration {
  private previous?: { thread?: string; turn?: string; status?: string }
  private result?: "done" | "error"
  private record?: string
  private title?: string
  private disposed = false

  constructor(private readonly options: RexIntegrationOptions) {}

  report(snapshot: WorkbenchLifecycleSnapshot): void {
    if (!this.options.enabled || this.disposed) return
    const thread = snapshot.summary?.id
    const turn = snapshot.turn
    const sameTurn =
      this.previous?.thread === thread && this.previous?.turn === turn?.id
    if (!sameTurn) this.result = undefined
    if (sameTurn && this.previous?.status === "running") {
      if (turn?.status === "complete") this.result = "done"
      else if (turn?.status === "failed") this.result = "error"
    }
    if (turn?.status === "running" || turn?.status === "interrupted")
      this.result = undefined
    this.previous = { thread, turn: turn?.id, status: turn?.status }

    let state: Status = "idle"
    let kind: "permission" | "question" | undefined
    if (
      snapshot.connection === "connected" &&
      snapshot.summary?.status !== "disconnected"
    ) {
      if (snapshot.pendingApprovals > 0) {
        state = "blocked"
        kind = "permission"
      } else if ((snapshot.pendingQuestions ?? 0) > 0) {
        state = "blocked"
        kind = "question"
      } else if (turn?.status === "running")
        state = snapshot.summary?.status === "blocked" ? "blocked" : "working"
      else if (this.result) state = this.result
      else if (turn?.status === "interrupted") state = "idle"
      else if (snapshot.summary?.status === "working") state = "working"
      else if (snapshot.summary?.status === "blocked") state = "blocked"
    } else {
      this.result = undefined
      this.previous = undefined
    }

    const title = singleLine(snapshot.summary?.title ?? "", 160)
    const terminalTitle = title ? `Vimex · ${title}` : "Vimex"
    if (terminalTitle !== this.title) {
      this.options.setTitle(terminalTitle)
      this.title = terminalTitle
    }
    const msg =
      state === "blocked"
        ? kind === "permission"
          ? "Approval required"
          : kind === "question"
            ? "Answer required"
            : "Waiting for input"
        : state === "done"
          ? "Response ready"
          : state === "error"
            ? "Turn failed"
            : state === "working"
              ? "Working"
              : snapshot.connection === "connected"
                ? "Ready"
                : "Disconnected"
    const sequence = `\x1b]7501;state=${state}:app=vimex${kind ? `:kind=${kind}` : ""}:msg=${Buffer.from(msg).toString("base64")}\x1b\\`
    if (sequence !== this.record) {
      this.options.write(sequence)
      this.record = sequence
    }
  }

  dispose(): void {
    if (!this.options.enabled || this.disposed) return
    this.disposed = true
    try {
      this.options.write("\x1b]7501;state=clear:app=vimex\x1b\\")
    } finally {
      this.options.setTitle("")
    }
  }
}

/** Keep terminal chrome single-line, bounded, and free of terminal controls. */
function singleLine(value: string, maxBytes: number): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  let result = ""
  let bytes = 0
  for (const char of clean) {
    bytes += Buffer.byteLength(char)
    if (bytes > maxBytes) break
    result += char
  }
  return result
}

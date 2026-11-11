import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { parseLocalState, type LocalState } from "@vimex/workbench"
import { stateDirectory } from "../config"
import { acquireFileLock } from "../process/file-lock"
import { JsonStore } from "./json-store"

export interface PaneIdentity {
  server: string
  session: string
  block: string
}

export interface PaneTarget {
  machine: string
  sshHost?: string
  thread?: string
  draftId?: string
  cwd: string
  localCwd: string
  config?: string
  model?: string
}

export interface PaneCheckpoint {
  version: 1
  instanceId: string
  active: boolean
  target: PaneTarget
  machines: Record<string, LocalState>
}

/** Never guess a server or recover another pane from a partial environment. */
export function paneIdentity(
  env: NodeJS.ProcessEnv = process.env,
): PaneIdentity | undefined {
  const { REX_SERVER: server, REX_SESSION: session, REX_BLOCK: block } = env
  return server && session && block ? { server, session, block } : undefined
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Vimex pane checkpoint")
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid Vimex pane checkpoint string")
  return value
}

export function parsePaneCheckpoint(value: unknown): PaneCheckpoint {
  const checkpoint = object(value)
  if (checkpoint.version !== 1 || typeof checkpoint.active !== "boolean")
    throw new Error("Invalid Vimex pane checkpoint version or active flag")
  const target = object(checkpoint.target)
  const machine = text(target.machine)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(machine))
    throw new Error("Invalid Vimex pane checkpoint machine")
  return {
    version: 1,
    instanceId: text(checkpoint.instanceId),
    active: checkpoint.active,
    target: {
      machine,
      ...(target.sshHost === undefined
        ? {}
        : { sshHost: text(target.sshHost) }),
      cwd: text(target.cwd),
      localCwd: text(target.localCwd),
      ...(target.thread === undefined ? {} : { thread: text(target.thread) }),
      ...(target.draftId === undefined
        ? {}
        : { draftId: text(target.draftId) }),
      ...(target.config === undefined ? {} : { config: text(target.config) }),
      ...(target.model === undefined ? {} : { model: text(target.model) }),
    },
    machines: Object.fromEntries(
      Object.entries(object(checkpoint.machines)).map(([id, state]) => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
          throw new Error("Invalid Vimex pane checkpoint machine")
        return [id, parseLocalState(state)]
      }),
    ),
  }
}

export class PaneStateStore {
  readonly path: string
  readonly directory: string
  private readonly store: JsonStore<{
    identity: PaneIdentity
    checkpoint: PaneCheckpoint
  }>

  constructor(
    readonly identity: PaneIdentity,
    root = stateDirectory(),
  ) {
    const key = JSON.stringify([
      text(identity.server),
      text(identity.session),
      text(identity.block),
    ])
    const hash = createHash("sha256").update(key).digest("hex")
    this.path = join(root, "panes", `${hash}.json`)
    this.directory = join(dirname(this.path), hash)
    this.store = new JsonStore(
      this.path,
      (value) => {
        const envelope = object(value)
        const saved = object(envelope.identity)
        if (
          saved.server !== identity.server ||
          saved.session !== identity.session ||
          saved.block !== identity.block
        )
          throw new Error("Vimex pane checkpoint identity does not match")
        return {
          identity,
          checkpoint: parsePaneCheckpoint(envelope.checkpoint),
        }
      },
      { durable: true },
    )
  }

  async read(): Promise<PaneCheckpoint | undefined> {
    return (await this.store.read())?.checkpoint
  }

  write(checkpoint: PaneCheckpoint): Promise<void> {
    return this.store.write({ identity: this.identity, checkpoint })
  }

  acquire(): Promise<(() => Promise<void>) | undefined> {
    return acquireFileLock(`${this.path}.lock`)
  }
}

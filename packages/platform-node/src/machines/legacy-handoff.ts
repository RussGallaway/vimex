import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  createHostTransaction,
  hostOperation,
  runHostCommand,
  type MachineHost,
} from "./host"

export interface LegacyHandoffRequest {
  source: MachineHost
  destination: MachineHost
  threadId: string
  rolloutPath: string
}
export interface PreparedLegacyHandoff {
  cwd: string
  rolloutPath: string
  verifySourceUnchanged(): Promise<void>
  /** Call only after destination resume and UI ownership switch succeeded. */
  finalize(): Promise<void>
  /** Removes only this operation's isolated destination worktree and staging. */
  cleanup(): Promise<void>
}
interface Snapshot {
  head: string
  indexPatch: Buffer
  worktreePatch: Buffer
  untracked: Array<{ path: string; data: string; mode: number }>
  rollout: string
  fingerprint: string
}
const git = async (host: MachineHost, args: readonly string[]) =>
  (
    await runHostCommand(host, [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ])
  ).stdout
const read = (host: MachineHost, path: string) =>
  hostOperation(host, { action: "read", path })
const write = (host: MachineHost, path: string, data: string, mode = 0o600) =>
  hostOperation(host, { action: "write", path, data, mode })
const remove = (host: MachineHost, path: string) =>
  hostOperation(host, { action: "remove", path })
const text = (data: Buffer) => data.toString("utf8").trim()

/** Validate native format before any destination writes. No transcript rewriting. */
export function validateLegacyRollout(
  contents: string,
  threadId: string,
): void {
  if (!contents.endsWith("\n"))
    throw new Error("Session checkpoint has an incomplete final record")
  const lines = contents.split("\n").filter((line) => line.length > 0)
  if (!lines.length) throw new Error("Session checkpoint is empty")
  let meta: Record<string, any> | undefined
  for (const [index, line] of lines.entries()) {
    let record: Record<string, any>
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error(`Session checkpoint record ${index + 1} is invalid`)
    }
    if (
      !record ||
      typeof record !== "object" ||
      ![
        "session_meta",
        "response_item",
        "event_msg",
        "turn_context",
        "compacted",
      ].includes(record.type)
    )
      throw new Error("Session checkpoint uses an unsupported record format")
    if (index === 0) {
      if (record.type !== "session_meta" || record.payload?.id !== threadId)
        throw new Error(
          "Session checkpoint identity does not match the selected thread",
        )
      meta = record.payload
      if (meta?.history_mode && meta.history_mode !== "legacy")
        throw new Error(
          "Paginated chats cannot be continued on another host yet",
        )
      if (meta?.history_base || meta?.subagent_history_start_ordinal != null)
        throw new Error(
          "Session checkpoint depends on another thread's history",
        )
    } else if (record.type === "session_meta") {
      if (
        record.payload?.history_mode &&
        record.payload.history_mode !== "legacy"
      )
        throw new Error(
          "Paginated chats cannot be continued on another host yet",
        )
      if (
        record.payload?.history_base ||
        record.payload?.subagent_history_start_ordinal != null
      )
        throw new Error(
          "Session checkpoint depends on another thread's history",
        )
    }
    const check = (value: unknown): void => {
      if (!value || typeof value !== "object") return
      if (Array.isArray(value)) {
        value.forEach(check)
        return
      }
      const obj = value as Record<string, unknown>
      if (
        obj.type === "local_image" ||
        obj.type === "localImage" ||
        (obj.type === "input_image" &&
          typeof obj.image_url === "string" &&
          !/^(?:data:|https?:)/u.test(obj.image_url))
      )
        throw new Error(
          "This session contains a host-local image attachment; native attachment transfer is not available",
        )
      if (
        obj.name === "spawn_agent" ||
        obj.name === "functions.spawn_agent" ||
        obj.type === "collab_agent_spawn_call"
      )
        throw new Error(
          "This session has subagent history; transfer of the complete session tree is not available",
        )
      Object.values(obj).forEach(check)
    }
    check(record.payload)
  }
}
async function snapshot(
  request: LegacyHandoffRequest,
  sourceRoot: MachineHost,
): Promise<Snapshot> {
  const head = text(await git(sourceRoot, ["rev-parse", "HEAD"]))
  const indexPatch = await git(sourceRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--cached",
    "HEAD",
    "--",
  ])
  const worktreePatch = await git(sourceRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--",
  ])
  const names = (
    await git(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort()
  const untracked: Snapshot["untracked"] = []
  let total = indexPatch.length + worktreePatch.length
  if (total > 64 * 1024 * 1024)
    throw new Error("Workspace changes exceed the 64 MiB handoff limit")
  for (const path of names) {
    if (
      posix.isAbsolute(path) ||
      path.split("/").some((part) => part === ".." || part === ".git")
    )
      throw new Error("Invalid untracked file path")
    const file = await read(sourceRoot, posix.join(sourceRoot.cwd, path))
    total += Buffer.from(file.data, "base64").length
    if (total > 64 * 1024 * 1024)
      throw new Error("Workspace changes exceed the 64 MiB handoff limit")
    untracked.push({ path, data: file.data, mode: file.mode })
  }
  const rollout = (await read(request.source, request.rolloutPath))
    .data as string
  validateLegacyRollout(
    Buffer.from(rollout, "base64").toString("utf8"),
    request.threadId,
  )
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        head,
        indexPatch: indexPatch.toString("base64"),
        worktreePatch: worktreePatch.toString("base64"),
        untracked,
        rollout,
      }),
    )
    .digest("hex")
  return { head, indexPatch, worktreePatch, untracked, rollout, fingerprint }
}

/**
 * Mirrors Codex Desktop's legacy rollout-path fork route with a fresh worktree.
 * Caller owns stopping submissions, checking live source idle state and matching
 * accounts, and forking the copied native checkpoint through the destination API.
 * No source Git branch/index or existing destination checkout is changed.
 */
export async function prepareLegacyHandoff(
  request: LegacyHandoffRequest,
): Promise<PreparedLegacyHandoff> {
  if (!request.threadId || !posix.isAbsolute(request.rolloutPath))
    throw new Error("A native session checkpoint is required")
  const sourceRoot: MachineHost = {
    ...request.source,
    cwd: text(await git(request.source, ["rev-parse", "--show-toplevel"])),
  }
  const destinationRoot: MachineHost = {
    ...request.destination,
    cwd: text(await git(request.destination, ["rev-parse", "--show-toplevel"])),
  }
  const sourceOrigin = text(
    await git(sourceRoot, ["remote", "get-url", "origin"]),
  )
  const destinationOrigin = text(
    await git(destinationRoot, ["remote", "get-url", "origin"]),
  )
  if (!sourceOrigin || sourceOrigin !== destinationOrigin)
    throw new Error(
      "Handoff requires matching repository origin URLs on both machines",
    )
  const resolvedSourceCwd = (
    await hostOperation(request.source, {
      action: "resolve",
      path: request.source.cwd,
    })
  ).path as string
  const relativeCwd = posix.relative(sourceRoot.cwd, resolvedSourceCwd)
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith("../") ||
    posix.isAbsolute(relativeCwd)
  )
    throw new Error("Source working directory is outside its repository")
  const submodules = text(
    await git(sourceRoot, ["submodule", "status", "--recursive"]),
  )
  if (submodules)
    throw new Error(
      "Handoff of repositories with submodules is not supported yet",
    )
  if ((await git(sourceRoot, ["ls-files", "--unmerged", "-z"])).length)
    throw new Error("Resolve Git merge conflicts before handing off")
  // A globally installed filter (e.g. LFS) is harmless unless attributes use it.
  // Refuse active filters because checkout can transform bytes or launch a process.
  const trackedPaths = (await git(sourceRoot, ["ls-files", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
  for (const host of [sourceRoot, destinationRoot]) {
    for (let offset = 0; offset < trackedPaths.length; offset += 128) {
      const attributes = (
        await git(host, [
          "check-attr",
          "-z",
          "filter",
          "--",
          ...trackedPaths.slice(offset, offset + 128),
        ])
      )
        .toString("utf8")
        .split("\0")
      for (let i = 2; i < attributes.length; i += 3)
        if (attributes[i] !== "unspecified" && attributes[i] !== "unset")
          throw new Error(
            "Native handoff does not support active Git clean/smudge filters",
          )
    }
  }
  const before = await snapshot(request, sourceRoot)
  const sourceTemp = (await hostOperation(request.source, { action: "temp" }))
    .path as string
  let destinationTemp: string | undefined
  let worktree: string | undefined
  let worktreeCreated = false
  let finalized = false
  const cleanup = async () => {
    if (finalized) return
    if (worktreeCreated && worktree) {
      await git(destinationRoot, ["worktree", "remove", "--force", worktree])
      worktreeCreated = false
    }
    if (destinationTemp) await remove(request.destination, destinationTemp)
    await remove(request.source, sourceTemp)
  }
  try {
    destinationTemp = await createHostTransaction(request.destination)
    const sourceBundle = posix.join(sourceTemp, "history.bundle")
    const bundle = posix.join(destinationTemp, "history.bundle")
    const rolloutPath = posix.join(destinationTemp, "rollout.jsonl")
    await git(sourceRoot, ["bundle", "create", sourceBundle, "HEAD"])
    await write(
      request.destination,
      bundle,
      (await read(request.source, sourceBundle)).data,
    )
    await git(destinationRoot, ["bundle", "verify", bundle])
    await git(destinationRoot, ["bundle", "unbundle", bundle])
    worktree = posix.join(destinationTemp, "worktree")
    await git(destinationRoot, [
      "worktree",
      "add",
      "--detach",
      worktree,
      before.head,
    ])
    worktreeCreated = true
    const target = { ...request.destination, cwd: worktree }
    for (const [name, patch, index] of [
      ["index.patch", before.indexPatch, true],
      ["working.patch", before.worktreePatch, false],
    ] as const) {
      if (!patch.length) continue
      const path = posix.join(destinationTemp, name)
      await write(request.destination, path, patch.toString("base64"))
      await git(target, [
        "apply",
        "--binary",
        ...(index ? ["--index"] : []),
        path,
      ])
    }
    for (const file of before.untracked)
      await write(
        request.destination,
        posix.join(worktree, file.path),
        file.data,
        file.mode,
      )
    await write(request.destination, rolloutPath, before.rollout)
    const cwd = posix.join(worktree, relativeCwd)
    await hostOperation(request.destination, { action: "resolve", path: cwd })
    const verifySourceUnchanged = async () => {
      const current = await snapshot(request, sourceRoot)
      if (current.fingerprint !== before.fingerprint)
        throw new Error(
          "Source session or workspace changed during handoff; the local session remains authoritative",
        )
    }
    await verifySourceUnchanged()
    const restored = await snapshot(
      { ...request, source: target, rolloutPath },
      target,
    )
    if (restored.fingerprint !== before.fingerprint)
      throw new Error(
        "Destination Git state did not match the source checkpoint; handoff cancelled",
      )
    return {
      cwd,
      rolloutPath,
      verifySourceUnchanged,
      cleanup,
      async finalize() {
        if (finalized) return
        for (const name of [
          "history.bundle",
          "rollout.jsonl",
          "index.patch",
          "working.patch",
        ])
          await remove(request.destination, posix.join(destinationTemp!, name))
        await remove(request.source, sourceTemp)
        finalized = true
      },
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Handoff failed; temporary worktree cleanup also failed",
      )
    }
    throw error
  }
}

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
  destinationMode?: "isolated" | "existing"
}
export interface PreparedLegacyHandoff {
  cwd: string
  rolloutPath: string
  verifySourceUnchanged(): Promise<void>
  /** Call only after destination resume and UI ownership switch succeeded. */
  finalize(): Promise<void>
  /** Rolls back only this operation; existing destination work is never force-cleaned. */
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
 * Source Git state is never changed. Isolated mode leaves existing checkouts alone;
 * explicit existing mode stages first and updates only a clean selected checkout.
 */
export async function prepareLegacyHandoff(
  request: LegacyHandoffRequest,
): Promise<PreparedLegacyHandoff> {
  if (request.destinationMode === "existing")
    return prepareExistingHandoff(request)
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

const paths = (buffer: Buffer) =>
  buffer.toString("utf8").split("\0").filter(Boolean)
async function branch(host: MachineHost): Promise<string | undefined> {
  const result = await hostOperation(host, {
    action: "exec",
    cwd: host.cwd,
    argv: ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
  })
  if (result.code === 1) return undefined
  if (result.code !== 0) throw new Error("Could not inspect checkout branch")
  return Buffer.from(result.stdout, "base64").toString("utf8").trim()
}

/** Stage and verify first, then update only a clean explicitly selected checkout. */
async function prepareExistingHandoff(
  request: LegacyHandoffRequest,
): Promise<PreparedLegacyHandoff> {
  const destination = {
    ...request.destination,
    cwd: (
      await hostOperation(request.destination, {
        action: "resolve",
        path: request.destination.cwd,
      })
    ).path as string,
  }
  const root = text(await git(destination, ["rev-parse", "--show-toplevel"]))
  if (root !== destination.cwd)
    throw new Error("Select the destination worktree root, not a subdirectory")
  const sourceRoot = text(
    await git(request.source, ["rev-parse", "--show-toplevel"]),
  )
  if (request.source.sshHost === destination.sshHost && sourceRoot === root)
    throw new Error("Source and destination must be different worktrees")
  const gitDir = text(
    await git(destination, ["rev-parse", "--absolute-git-dir"]),
  )
  const lock = posix.join(gitDir, "vimex-handoff.lock")
  await hostOperation(destination, { action: "lock", path: lock })
  let locked = true
  const unlock = async () => {
    if (!locked) return
    await hostOperation(destination, { action: "unlock", path: lock })
    locked = false
  }
  let staged: PreparedLegacyHandoff | undefined
  let mutated = false
  let finished = false
  let expected: string | undefined
  let sourceBranch: string | undefined
  let originalBranch: string | undefined
  let originalHead = ""
  let previousSourceHead: string | undefined
  let desiredHead = ""
  let branchTouched = false
  let state: Snapshot | undefined
  const applied: Array<{ path: string; index: boolean }> = []
  const createdFiles: string[] = []
  const fingerprint = async () => {
    const snap = await snapshot(
      { ...request, source: destination, rolloutPath: staged!.rolloutPath },
      destination,
    )
    return `${(await branch(destination)) ?? "detached"}:${snap.fingerprint}`
  }
  const checkpoint = async () => {
    expected = await fingerprint()
  }
  const verifyDestination = async () => {
    if (expected !== (await fingerprint()))
      throw new Error(
        `Destination changed during handoff; retained ${destination.cwd} for recovery`,
      )
  }
  const cleanStaging = async () => {
    try {
      await staged?.cleanup()
    } finally {
      await unlock()
    }
  }
  const cleanup = async () => {
    if (finished) return
    try {
      if (mutated) {
        await verifyDestination()
        if (
          originalBranch &&
          originalBranch !== sourceBranch &&
          text(
            await git(destination, [
              "rev-parse",
              `refs/heads/${originalBranch}`,
            ]),
          ) !== originalHead
        )
          throw new Error("Original destination branch changed during handoff")
        for (const file of createdFiles) await remove(destination, file)
        for (const patch of [...applied].reverse()) {
          if (patch.index) await git(destination, ["update-index", "--refresh"])
          await git(destination, [
            "apply",
            "--reverse",
            "--binary",
            ...(patch.index ? ["--index"] : []),
            patch.path,
          ])
        }
        // Non-forced checkout protects any unrelated files that appeared meanwhile.
        await git(destination, [
          "checkout",
          "--no-overwrite-ignore",
          "--detach",
          originalHead,
        ])
        if (sourceBranch && branchTouched) {
          const ref = `refs/heads/${sourceBranch}`
          if (previousSourceHead)
            await git(destination, [
              "update-ref",
              ref,
              previousSourceHead,
              desiredHead,
            ])
          else await git(destination, ["update-ref", "-d", ref, desiredHead])
        }
        if (originalBranch)
          await git(destination, [
            "checkout",
            "--no-overwrite-ignore",
            originalBranch,
            "--",
          ])
        mutated = false
      }
      await cleanStaging()
      finished = true
    } catch (error) {
      // Preserve both checkouts and checkpoint if concurrent edits prevent safe rollback.
      await unlock()
      throw new Error(
        `Existing destination recovery needs attention at ${destination.cwd}; staging retained at ${staged?.cwd ?? "not created"}`,
        { cause: error },
      )
    }
  }
  try {
    if (
      text(
        await git(destination, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
      )
    )
      throw new Error(
        "Existing destination must be clean, including untracked files; ignored dependencies and local configuration may remain",
      )
    const sparse = await hostOperation(destination, {
      action: "exec",
      cwd: destination.cwd,
      argv: ["git", "config", "--bool", "core.sparseCheckout"],
    })
    if (Buffer.from(sparse.stdout, "base64").toString("utf8").trim() === "true")
      throw new Error("Existing sparse checkouts are not supported for handoff")
    const indexFlags = paths(await git(destination, ["ls-files", "-v", "-z"]))
    if (indexFlags.some((entry) => /^[a-zS] /.test(entry)))
      throw new Error(
        "Clear assume-unchanged and skip-worktree flags before handoff",
      )
    if (text(await git(destination, ["submodule", "status", "--recursive"])))
      throw new Error("Existing destinations with submodules are not supported")
    originalHead = text(await git(destination, ["rev-parse", "HEAD"]))
    originalBranch = await branch(destination)
    sourceBranch = await branch(request.source)
    const originalFiles = paths(await git(destination, ["ls-files", "-z"]))
    for (let offset = 0; offset < originalFiles.length; offset += 128) {
      const attrs = paths(
        await git(destination, [
          "check-attr",
          "-z",
          "filter",
          "--",
          ...originalFiles.slice(offset, offset + 128),
        ]),
      )
      for (let index = 2; index < attrs.length; index += 3)
        if (attrs[index] !== "unspecified" && attrs[index] !== "unset")
          throw new Error(
            "Existing destination uses active Git checkout filters",
          )
    }
    const ignored = paths(
      await git(destination, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ]),
    )
    // The isolated path already verifies exact history, patches, filters and source stability.
    staged = await prepareLegacyHandoff({
      ...request,
      destination,
      destinationMode: "isolated",
    })
    const stagedRoot = text(
      await git({ ...destination, cwd: staged.cwd }, [
        "rev-parse",
        "--show-toplevel",
      ]),
    )
    const stagedHost = { ...destination, cwd: stagedRoot }
    state = await snapshot(
      { ...request, source: stagedHost, rolloutPath: staged.rolloutPath },
      stagedHost,
    )
    desiredHead = state.head
    // Ignored environment files stay local, but must remain ignored by the arriving tree.
    // Otherwise verification could scan dependencies and the prepared checkout would no longer be clean.
    for (let offset = 0; offset < ignored.length; offset += 128) {
      const batch = ignored.slice(offset, offset + 128)
      const checked = await hostOperation(stagedHost, {
        action: "exec",
        cwd: stagedHost.cwd,
        argv: ["git", "check-ignore", "--no-index", "-z", "--stdin"],
        stdin: Buffer.from(`${batch.join("\0")}\0`).toString("base64"),
      })
      if (checked.code !== 0 && checked.code !== 1)
        throw new Error("Could not check preserved ignored files")
      const stillIgnored = new Set(paths(Buffer.from(checked.stdout, "base64")))
      for (const path of batch)
        if (!stillIgnored.has(path))
          throw new Error(
            `Source ignore rules would expose destination environment path: ${path}`,
          )
    }
    const incoming = new Set([
      ...paths(
        await git(stagedHost, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
      ),
      ...paths(await git(stagedHost, ["ls-files", "-z"])),
      ...state.untracked.map((file) => file.path),
    ])
    await hostOperation(destination, {
      action: "transferPaths",
      cwd: destination.cwd,
      paths: [...incoming],
      tracked: originalFiles,
    })
    if (sourceBranch) {
      const ref = `refs/heads/${sourceBranch}`
      const refs = paths(
        await git(destination, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00",
          ref,
        ]),
      )
      // Resolve the exact ref rather than prefix-matching similarly named branches.
      const match = refs.findIndex((value) => value.trim() === ref)
      if (match >= 0) previousSourceHead = refs[match + 1]?.trim()
      if (previousSourceHead) {
        await git(destination, [
          "merge-base",
          "--is-ancestor",
          previousSourceHead,
          desiredHead,
        ]).catch(() => {
          throw new Error(
            `Destination branch ${sourceBranch} has diverged or is ahead; resolve it before handoff`,
          )
        })
      }
      const worktrees = text(
        await git(destination, ["worktree", "list", "--porcelain"]),
      )
      for (const entry of worktrees.split("\n\n")) {
        const lines = entry.split("\n")
        if (
          lines.includes(`branch ${ref}`) &&
          !lines.includes(`worktree ${destination.cwd}`)
        )
          throw new Error(
            `Branch ${sourceBranch} is already checked out in another worktree`,
          )
      }
    }
    // Recheck after potentially slow staging, immediately before touching the checkout.
    if (
      text(
        await git(destination, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ]),
      ) ||
      text(await git(destination, ["rev-parse", "HEAD"])) !== originalHead ||
      (await branch(destination)) !== originalBranch
    )
      throw new Error("Destination changed while preparing handoff")
    await staged.verifySourceUnchanged()
    if ((await branch(request.source)) !== sourceBranch)
      throw new Error("Source branch changed during handoff")
    await checkpoint()
    // Mark unknown before each mutation. An ambiguous command failure retains the checkout.
    const mutate = async (operation: () => Promise<unknown>) => {
      mutated = true
      expected = undefined
      await operation()
      await checkpoint()
    }
    if (sourceBranch) {
      if (previousSourceHead) {
        await mutate(() =>
          git(destination, [
            "checkout",
            "--no-overwrite-ignore",
            sourceBranch!,
            "--",
          ]),
        )
        await mutate(async () => {
          await git(destination, [
            "merge",
            "--ff-only",
            "--no-overwrite-ignore",
            desiredHead,
          ])
          branchTouched = true
        })
      } else
        await mutate(async () => {
          await git(destination, [
            "checkout",
            "--no-overwrite-ignore",
            "-b",
            sourceBranch!,
            desiredHead,
            "--",
          ])
          branchTouched = true
        })
    } else
      await mutate(() =>
        git(destination, [
          "checkout",
          "--no-overwrite-ignore",
          "--detach",
          desiredHead,
        ]),
      )
    for (const [name, patch, index] of [
      ["existing-index.patch", state.indexPatch, true],
      ["existing-working.patch", state.worktreePatch, false],
    ] as const) {
      if (!patch.length) continue
      const path = posix.join(posix.dirname(staged.rolloutPath), name)
      await write(destination, path, patch.toString("base64"))
      await mutate(async () => {
        await git(destination, [
          "apply",
          "--binary",
          ...(index ? ["--index"] : []),
          path,
        ])
        applied.push({ path, index })
      })
    }
    for (const file of state.untracked) {
      const path = posix.join(destination.cwd, file.path)
      await mutate(async () => {
        await write(destination, path, file.data, file.mode)
        createdFiles.push(path)
      })
    }
    const restored = await snapshot(
      { ...request, source: destination, rolloutPath: staged.rolloutPath },
      destination,
    )
    if (restored.fingerprint !== state.fingerprint)
      throw new Error(
        "Existing destination did not match the source checkpoint",
      )
    const stagedCwd = (
      await hostOperation(destination, { action: "resolve", path: staged.cwd })
    ).path as string
    const relativeCwd = posix.relative(stagedRoot, stagedCwd)
    const cwd = posix.join(destination.cwd, relativeCwd)
    await hostOperation(destination, { action: "resolve", path: cwd })
    return {
      cwd,
      rolloutPath: staged.rolloutPath,
      async verifySourceUnchanged() {
        await staged!.verifySourceUnchanged()
        if ((await branch(request.source)) !== sourceBranch)
          throw new Error("Source branch changed during handoff")
        await verifyDestination()
      },
      cleanup,
      async finalize() {
        if (finished) return
        // Once source retirement commits, cleanup must never roll back active destination work.
        finished = true
        await cleanStaging()
      },
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Handoff failed; existing checkout retained for recovery at ${destination.cwd}`,
      )
    }
    throw error
  }
}

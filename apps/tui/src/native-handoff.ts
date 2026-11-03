import {
  captureHistoryBundle,
  stageHistoryBundle,
  assertNoStoredGoals,
  type HistoryBundle,
  type StagedHistoryBundle,
} from "@vimex/platform-node"
import type { MachineNavigation, MachineRuntime } from "@vimex/workbench"
import type { createCodexGateways } from "@vimex/codex-app-server"
import type {
  PreparedLegacyHandoff,
  LegacyHandoffRequest,
} from "@vimex/platform-node"
import type { MachineTarget } from "./machine-navigation"

type Gateway = ReturnType<typeof createCodexGateways>
export interface NativeHandoffOptions {
  navigation: MachineNavigation
  gateways: Map<string, Gateway>
  target(id: string): MachineTarget
  prepare(request: LegacyHandoffRequest): Promise<PreparedLegacyHandoff>
  captureHistory?: typeof captureHistoryBundle
  notice(message: string): void
  rememberDestination?(input: {
    sourceId: string
    targetId: string
    cwd: string
    destinationCwd: string
  }): Promise<void>
}
function requireIdle(status: { type: string }) {
  if (status.type !== "idle" && status.type !== "notLoaded")
    throw new Error(
      "Wait for the source session to become idle before handing off",
    )
}
async function inspectPortableHistory(
  options: NativeHandoffOptions,
  sourceId: string,
  threadId: string,
): Promise<HistoryBundle | undefined> {
  const source = options.gateways.get(sourceId)
  if (!source) throw new Error("Source machine connection is unavailable")
  const info = await source.nativeHandoff.inspect(threadId)
  requireIdle(info.status)
  if (
    (await source.conversation.listBackgroundTerminals?.(threadId as never))
      ?.length
  )
    throw new Error(
      "Stop background terminals before handing off; running processes cannot move",
    )
  if (info.historyMode !== "legacy" && info.historyMode !== "paginated")
    throw new Error("This native history format is not supported for handoff")
  const target = options.target(sourceId)
  await source.nativeHandoff.assertPortable(threadId)
  const bundle = await (options.captureHistory ?? captureHistoryBundle)(
    { sshHost: target.sshHost, cwd: info.cwd },
    threadId,
    async (id) => {
      await source.nativeHandoff.assertPortable(id, id === threadId)
      return (await source.nativeHandoff.inspect(id)).rolloutPath
    },
    (id) => source.nativeHandoff.referencedThreads(id),
  )
  if (bundle.hasSubagents) {
    if (info.parentThreadId)
      throw new Error(
        "Hand off the parent session to move its complete subagent tree",
      )
    const owned = new Set([
      threadId,
      ...(await source.nativeHandoff.ownedDescendants(threadId)),
    ])
    const external = bundle.files.find(
      (file) => file.complete && !owned.has(file.id),
    )
    if (external)
      throw new Error(
        `This session references agents owned by another session (${external.id}). Cross-session agent trees cannot be handed off together yet; hand off their original parent session instead`,
      )
    const details = source.nativeHandoff.serverDetails()
    await assertNoStoredGoals(
      { sshHost: target.sshHost },
      details.codexHome,
      bundle.files.filter((file) => file.complete).map((file) => file.id),
      details.version,
    )
    for (const file of bundle.files.filter((file) => file.complete)) {
      const child = await source.nativeHandoff.inspect(file.id)
      if (child.cwd !== info.cwd)
        throw new Error(
          `Agent session ${file.id} uses a separate working directory (${child.cwd}); transfer of separate agent workspaces is not supported yet`,
        )
      if (
        child.status.type === "idle" &&
        (await source.conversation.listBackgroundTerminals?.(file.id as never))
          ?.length
      )
        throw new Error(
          `Stop background terminals in agent ${file.id} before handing off the tree`,
        )
    }
  }
  return info.historyMode === "paginated" || bundle.hasSubagents
    ? bundle
    : undefined
}
/** Read-only eligibility check before asking the user to choose a destination. */
export async function nativeHandoffPreflight(
  options: NativeHandoffOptions,
  input: { sourceId: string; threadId: string },
): Promise<void> {
  await inspectPortableHistory(options, input.sourceId, input.threadId)
}
/** A two-phase transition: destination validation precedes source retirement. */
export function nativeHandoff(
  options: NativeHandoffOptions,
): NonNullable<MachineNavigation["handoff"]> {
  return async (input) => {
    const source = options.gateways.get(input.sourceId)
    if (!source) throw new Error("Source machine connection is unavailable")
    const info = await source.nativeHandoff.inspect(input.threadId)
    input.onProgress?.("checking")
    const bundle = await inspectPortableHistory(
      options,
      input.sourceId,
      input.threadId,
    )
    const sourceDigest = bundle
      ? await source.nativeHandoff.historyDigest(input.threadId)
      : undefined
    const tree = Boolean(bundle?.hasSubagents)
    const completeIds =
      bundle?.files
        .filter((file) => file.complete || file.id === input.threadId)
        .map((file) => file.id) ?? []
    const digests = new Map<string, string>()
    const archived = new Set<string>()
    if (tree)
      for (const id of completeIds) {
        digests.set(id, await source.nativeHandoff.historyDigest(id))
        if (await source.nativeHandoff.isArchived(id)) archived.add(id)
      }
    const sourceIdentity = await source.nativeHandoff.accountIdentity()
    const ownedIds = tree
      ? new Set([
          input.threadId,
          ...(await source.nativeHandoff.ownedDescendants(input.threadId)),
        ])
      : new Set<string>()
    if (tree && [...ownedIds].some((id) => !completeIds.includes(id)))
      throw new Error(
        "Source agent catalog contains a session missing from the captured tree",
      )
    const parents = new Map<string, string | null | undefined>()
    if (tree)
      for (const id of completeIds)
        parents.set(id, (await source.nativeHandoff.inspect(id)).parentThreadId)
    let destination: MachineRuntime | undefined
    let checkpoint: PreparedLegacyHandoff | undefined
    let imported: StagedHistoryBundle | undefined
    let destinationThread: string | undefined
    let forkAttempted = false
    let committed = false
    let ownershipUncertain = false
    let cleaned = false
    const cleanup = async () => {
      if (cleaned || committed || ownershipUncertain) return
      if (forkAttempted && !destinationThread) {
        options.notice(
          `Destination ${tree ? "tree activation" : "fork"} could not be confirmed. Native history and prepared workspace ${checkpoint?.cwd ?? ""} were retained on ${input.targetId}; inspect its sessions before retrying`,
        )
        return
      }
      // Remove the imported session from normal listings before discarding its workspace.
      if (destinationThread)
        await options.gateways
          .get(input.targetId)
          ?.nativeHandoff.archiveSource(destinationThread)
      await checkpoint?.cleanup()
      if (!destinationThread) await imported?.cleanup()
      else if (imported)
        options.notice(
          "Imported native history was retained because the archived destination fork still references it",
        )
      cleaned = true
    }
    try {
      destination = await options.navigation.open(
        input.targetId,
        input.destinationCwd,
      )
      await destination.connection.connect()
      const targetGateway = options.gateways.get(input.targetId)!
      if (
        sourceIdentity !== (await targetGateway.nativeHandoff.accountIdentity())
      )
        throw new Error(
          "Handoff requires the same signed-in ChatGPT account and workspace on both machines",
        )
      const sourceTarget = options.target(input.sourceId)
      const destinationTarget = options.target(input.targetId)
      if (
        bundle &&
        source.nativeHandoff.serverDetails().version !==
          targetGateway.nativeHandoff.serverDetails().version
      )
        throw new Error(
          "Paginated handoff requires the same running Codex app-server version on both machines; update and reconnect both servers",
        )
      if (tree) {
        const targetDetails = targetGateway.nativeHandoff.serverDetails()
        await assertNoStoredGoals(
          { sshHost: destinationTarget.sshHost },
          targetDetails.codexHome,
          completeIds,
          targetDetails.version,
        )
        const extras = (
          await targetGateway.nativeHandoff.ownedDescendants(input.threadId)
        ).filter((id) => !ownedIds.has(id))
        if (extras.length)
          throw new Error(
            `Destination has extra agents outside the incoming tree (${extras.join(", ")}); handoff would affect unrelated sessions`,
          )
      }
      input.onProgress?.("preparing")
      checkpoint = await options.prepare({
        source: { sshHost: sourceTarget.sshHost, cwd: info.cwd },
        destination: {
          sshHost: destinationTarget.sshHost,
          cwd: destination.cwd,
        },
        destinationMode:
          input.isolated || input.destinationCwd === undefined
            ? "isolated"
            : "existing",
        threadId: input.threadId,
        rolloutPath: info.rolloutPath,
        paginatedHistory: Boolean(bundle),
      })
      requireIdle((await source.nativeHandoff.inspect(input.threadId)).status)
      input.onProgress?.("restoring")
      if (bundle) {
        imported = await stageHistoryBundle(
          bundle,
          { sshHost: destinationTarget.sshHost, cwd: checkpoint.cwd },
          targetGateway.nativeHandoff.serverDetails().codexHome,
          async (id) => {
            const path = await targetGateway.nativeHandoff.locate(id)
            if (path)
              await targetGateway.nativeHandoff.assertPortable(
                id,
                !tree && id === input.threadId,
              )
            if (tree && path && completeIds.includes(id)) {
              const info = await targetGateway.nativeHandoff.inspect(id)
              if (
                info.status.type !== "notLoaded" ||
                !(await targetGateway.nativeHandoff.isArchived(id))
              )
                throw new Error(
                  `Destination already has an unarchived or loaded session ${id}; archive it before moving the tree here`,
                )
              const details = targetGateway.nativeHandoff.serverDetails()
              await assertNoStoredGoals(
                { sshHost: destinationTarget.sshHost },
                details.codexHome,
                [id],
                details.version,
              )
            }
            return path
          },
          tree
            ? {
                authorizeUpdate: async (id) => {
                  const info = await targetGateway.nativeHandoff.inspect(id)
                  if (
                    info.status.type !== "notLoaded" ||
                    !(await targetGateway.nativeHandoff.isArchived(id))
                  )
                    throw new Error(
                      `Destination session ${id} must be archived and unloaded before its checkpoint can advance`,
                    )
                },
              }
            : undefined,
        )
        if (tree) {
          forkAttempted = true
          imported.retain()
          if (await targetGateway.nativeHandoff.isArchived(input.threadId))
            await targetGateway.nativeHandoff.unarchiveTree(input.threadId)
          for (const file of bundle.files) {
            const path = await targetGateway.nativeHandoff.locate(file.id)
            if (!path)
              throw new Error(`Imported agent checkpoint ${file.id} is missing`)
            imported.paths.set(file.id, path)
          }
        }
        for (const id of [...imported.createdIds, ...imported.updatedIds])
          await targetGateway.nativeHandoff.hydrateHistory(id, checkpoint.cwd)
        await imported.verify()
        if (
          (await targetGateway.nativeHandoff.historyDigest(input.threadId)) !==
          sourceDigest
        )
          throw new Error(
            "Imported session history differs from the source; handoff cancelled",
          )
      }
      forkAttempted = true
      const activated = tree
        ? await targetGateway.nativeHandoff.resumeTree(
            input.threadId,
            imported!.paths.get(input.threadId)!,
            checkpoint.cwd,
          )
        : await targetGateway.nativeHandoff.forkFromPath(
            input.threadId,
            imported?.paths.get(input.threadId) ?? checkpoint.rolloutPath,
            checkpoint.cwd,
          )
      destinationThread = activated.summary.id
      if (tree && destinationThread !== input.threadId)
        throw new Error("Native agent tree identity changed during activation")
      if (tree) {
        const pending = [...ownedIds].filter((id) => id !== input.threadId)
        const restored = new Set([input.threadId])
        while (pending.length) {
          const index = pending.findIndex((id) =>
            restored.has(parents.get(id) ?? ""),
          )
          if (index < 0)
            throw new Error(
              "Source live agent tree has an archived or missing parent",
            )
          const id = pending.splice(index, 1)[0]!
          await targetGateway.nativeHandoff.resumeTree(
            id,
            imported!.paths.get(id)!,
            checkpoint.cwd,
          )
          const child = await targetGateway.nativeHandoff.inspect(id)
          if (
            child.parentThreadId !== parents.get(id) ||
            child.cwd !== checkpoint.cwd ||
            child.sessionId !== input.threadId
          )
            throw new Error(
              `Native agent ${id} did not restore its parent, workspace, and session ownership`,
            )
          restored.add(id)
        }
        const restoredIds = new Set([
          input.threadId,
          ...(await targetGateway.nativeHandoff.ownedDescendants(
            input.threadId,
          )),
        ])
        if (
          restoredIds.size !== ownedIds.size ||
          [...restoredIds].some((id) => !ownedIds.has(id))
        )
          throw new Error("Restored native agent tree differs from the source")
      }
      if (tree)
        for (const [id, digest] of digests) {
          if ((await targetGateway.nativeHandoff.historyDigest(id)) !== digest)
            throw new Error(
              `Imported agent history differs for ${id}; handoff cancelled`,
            )
        }
      if (bundle) {
        await bundle.verifySourceUnchanged()
        if (
          (await source.nativeHandoff.historyDigest(input.threadId)) !==
            sourceDigest ||
          (await targetGateway.nativeHandoff.historyDigest(
            destinationThread,
          )) !== sourceDigest
        )
          throw new Error(
            "Forked session history differs from the source; handoff cancelled",
          )
      }
      await checkpoint.verifySourceUnchanged()
      const prepared = checkpoint
      return {
        ...destination,
        cwd: prepared.cwd,
        threadId: destinationThread,
        async commit() {
          await prepared.verifySourceUnchanged()
          if (bundle) {
            for (const file of bundle.files)
              await source.nativeHandoff.assertPortable(
                file.id,
                file.id === input.threadId,
              )
            await bundle.verifySourceUnchanged()
            await imported!.verify()
            if (
              (await targetGateway.nativeHandoff.historyDigest(
                destinationThread!,
              )) !== sourceDigest
            )
              throw new Error(
                "Destination session changed before handoff completed",
              )
          }
          if (tree) {
            const sourceDetails = source.nativeHandoff.serverDetails()
            await assertNoStoredGoals(
              { sshHost: sourceTarget.sshHost },
              sourceDetails.codexHome,
              completeIds,
              sourceDetails.version,
            )
            const targetDetails = targetGateway.nativeHandoff.serverDetails()
            await assertNoStoredGoals(
              { sshHost: destinationTarget.sshHost },
              targetDetails.codexHome,
              completeIds,
              targetDetails.version,
            )
            for (const id of completeIds) {
              await source.nativeHandoff.assertPortable(id, false)
              const original = await source.nativeHandoff.inspect(id)
              if (
                original.status.type === "idle" &&
                (
                  await source.conversation.listBackgroundTerminals?.(
                    id as never,
                  )
                )?.length
              )
                throw new Error(
                  `Source agent ${id} started background work before handoff committed`,
                )
              await targetGateway.nativeHandoff.assertPortable(id, false)
              const child = await targetGateway.nativeHandoff.inspect(id)
              if (
                child.status.type === "idle" &&
                (
                  await targetGateway.conversation.listBackgroundTerminals?.(
                    id as never,
                  )
                )?.length
              )
                throw new Error(
                  `Destination agent ${id} started background work before handoff committed`,
                )
            }
            for (const gateway of [source, targetGateway]) {
              const current = new Set([
                input.threadId,
                ...(await gateway.nativeHandoff.ownedDescendants(
                  input.threadId,
                )),
              ])
              if (
                current.size !== ownedIds.size ||
                [...current].some((id) => !ownedIds.has(id))
              )
                throw new Error(
                  "Native agent membership changed before handoff committed",
                )
            }
            for (const [id, digest] of digests) {
              if (
                (await source.nativeHandoff.historyDigest(id)) !== digest ||
                (await targetGateway.nativeHandoff.historyDigest(id)) !== digest
              )
                throw new Error(
                  `Agent history changed before handoff completed: ${id}`,
                )
            }
          }
          input.onProgress?.("switching")
          requireIdle(
            (await source.nativeHandoff.inspect(input.threadId)).status,
          )
          await source.nativeHandoff.assertPortable(input.threadId)
          // An RPC rejection may mean the archive succeeded but its reply was
          // lost. Retain the validated destination until ownership is resolved.
          ownershipUncertain = true
          try {
            await source.nativeHandoff.archiveSource(input.threadId)
          } catch (cause) {
            throw new Error(
              `Source retirement could not be confirmed. The prepared session ${destinationThread} on ${input.targetId} and worktree ${prepared.cwd} were retained; reconnect before continuing.`,
              { cause },
            )
          }
          committed = true
          ownershipUncertain = false
          // Cleanup failure must not roll back a committed ownership transition.
          await prepared
            .finalize()
            .catch((error) =>
              options.notice(
                `Session moved; temporary handoff files need cleanup: ${String(error)}`,
              ),
            )
          // The destination fork still references these native checkpoints.
          // Archive only our newly imported copies to hide duplicate sessions;
          // retain their bytes and never retire preexisting destination IDs.
          for (const id of imported?.createdIds ?? []) {
            if (tree && completeIds.includes(id)) continue
            await targetGateway.nativeHandoff
              .archiveSource(id)
              .catch((error) =>
                options.notice(
                  `Session moved; imported history ${id} remains visible and needs archiving: ${String(error)}`,
                ),
              )
          }
          if (tree)
            for (const id of archived) {
              if (id === destinationThread) continue
              await targetGateway.nativeHandoff
                .archiveSource(id)
                .catch((error) =>
                  options.notice(
                    `Session moved; previously archived agent ${id} needs archiving: ${String(error)}`,
                  ),
                )
            }
          if (input.destinationCwd !== undefined && !input.isolated)
            await options
              .rememberDestination?.({
                sourceId: input.sourceId,
                targetId: input.targetId,
                cwd: info.cwd,
                destinationCwd: destination!.cwd,
              })
              .catch((error) =>
                options.notice(
                  `Session moved; destination preference could not be saved: ${String(error)}`,
                ),
              )
        },
        rollback: cleanup,
      }
    } catch (error) {
      try {
        await cleanup()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Handoff failed and cleanup needs attention",
        )
      } finally {
        await destination?.connection.close().catch(() => {})
      }
      if (forkAttempted && !destinationThread)
        throw new Error(
          `Destination ${tree ? "tree activation" : "fork"} could not be confirmed on ${input.targetId}. Native history and prepared workspace ${checkpoint?.cwd ?? ""} were retained; inspect destination sessions before retrying. ${String(error)}`,
          { cause: error },
        )
      throw error
    }
  }
}

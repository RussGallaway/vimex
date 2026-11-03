import {
  captureHistoryBundle,
  stageHistoryBundle,
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
  )
  return info.historyMode === "paginated" ? bundle : undefined
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
    const sourceIdentity = await source.nativeHandoff.accountIdentity()
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
          `Destination fork could not be confirmed. Native history and prepared workspace ${checkpoint?.cwd ?? ""} were retained on ${input.targetId}; inspect its sessions before retrying`,
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
                id === input.threadId,
              )
            return path
          },
        )
        for (const id of imported.createdIds)
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
      const fork = await targetGateway.nativeHandoff.forkFromPath(
        input.threadId,
        imported?.paths.get(input.threadId) ?? checkpoint.rolloutPath,
        checkpoint.cwd,
      )
      destinationThread = fork.summary.id
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
          for (const id of imported?.createdIds ?? [])
            await targetGateway.nativeHandoff
              .archiveSource(id)
              .catch((error) =>
                options.notice(
                  `Session moved; imported history ${id} remains visible and needs archiving: ${String(error)}`,
                ),
              )
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
          `Destination fork could not be confirmed on ${input.targetId}. Native history and prepared workspace ${checkpoint?.cwd ?? ""} were retained; inspect destination sessions before retrying. ${String(error)}`,
          { cause: error },
        )
      throw error
    }
  }
}

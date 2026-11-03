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
/** A two-phase transition: destination validation precedes source retirement. */
export function nativeHandoff(
  options: NativeHandoffOptions,
): NonNullable<MachineNavigation["handoff"]> {
  return async (input) => {
    const source = options.gateways.get(input.sourceId)
    if (!source) throw new Error("Source machine connection is unavailable")
    const info = await source.nativeHandoff.inspect(input.threadId)
    if (info.historyMode !== "legacy")
      throw new Error(
        "Paginated chats cannot be continued on another host yet; your session remains here",
      )
    requireIdle(info.status)
    if (
      (
        await source.conversation.listBackgroundTerminals?.(
          input.threadId as never,
        )
      )?.length
    )
      throw new Error(
        "Stop background terminals before handing off; running processes cannot move",
      )
    const sourceIdentity = await source.nativeHandoff.accountIdentity()
    let destination: MachineRuntime | undefined
    let checkpoint: PreparedLegacyHandoff | undefined
    let destinationThread: string | undefined
    let committed = false
    let ownershipUncertain = false
    let cleaned = false
    const cleanup = async () => {
      if (cleaned || committed || ownershipUncertain) return
      // Remove the imported session from normal listings before discarding its workspace.
      if (destinationThread)
        await options.gateways
          .get(input.targetId)
          ?.nativeHandoff.archiveSource(destinationThread)
      await checkpoint?.cleanup()
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
      checkpoint = await options.prepare({
        source: { sshHost: sourceTarget.sshHost, cwd: info.cwd },
        destination: {
          sshHost: destinationTarget.sshHost,
          cwd: destination.cwd,
        },
        destinationMode:
          input.destinationCwd === undefined ? "isolated" : "existing",
        threadId: input.threadId,
        rolloutPath: info.rolloutPath,
      })
      requireIdle((await source.nativeHandoff.inspect(input.threadId)).status)
      const fork = await targetGateway.nativeHandoff.forkFromPath(
        input.threadId,
        checkpoint.rolloutPath,
        checkpoint.cwd,
      )
      destinationThread = fork.summary.id
      await checkpoint.verifySourceUnchanged()
      const prepared = checkpoint
      return {
        ...destination,
        cwd: prepared.cwd,
        threadId: destinationThread,
        async commit() {
          await prepared.verifySourceUnchanged()
          requireIdle(
            (await source.nativeHandoff.inspect(input.threadId)).status,
          )
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
          if (input.destinationCwd !== undefined)
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
      throw error
    }
  }
}

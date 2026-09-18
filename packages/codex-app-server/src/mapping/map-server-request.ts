import { itemId, threadId, turnId } from "@vimex/conversation"
import type { Approval, ApprovalChoice } from "@vimex/approvals"
import type { RequestId } from "../generated/v0_154_0/RequestId"
import type { CommandExecutionRequestApprovalParams } from "../generated/v0_154_0/v2/CommandExecutionRequestApprovalParams"
import type { FileChangeRequestApprovalParams } from "../generated/v0_154_0/v2/FileChangeRequestApprovalParams"
import type { PermissionsRequestApprovalParams } from "../generated/v0_154_0/v2/PermissionsRequestApprovalParams"
import type { ToolRequestUserInputParams } from "../generated/v0_154_0/v2/ToolRequestUserInputParams"
import type { ApplyPatchApprovalParams } from "../generated/v0_154_0/ApplyPatchApprovalParams"
import type { ExecCommandApprovalParams } from "../generated/v0_154_0/ExecCommandApprovalParams"
import type { ServerCall } from "../rpc/request-router"
import { safeStringify } from "./map-item"

export interface NormalizedUserQuestion {
  id: string
  header: string
  question: string
  allowOther: boolean
  secret: boolean
  options?: readonly { label: string; description: string }[]
}

export type ServerRequestEvent =
  | { type: "approval.requested"; requestId: RequestId; method: string; approval: Approval }
  | { type: "userInput.requested"; requestId: RequestId; threadId: ReturnType<typeof threadId>; turnId: ReturnType<typeof turnId>; itemId: ReturnType<typeof itemId>; isBlocking: boolean; questions: readonly NormalizedUserQuestion[] }
  | { type: "unknown"; method?: string; payload: unknown }

export function mapServerRequest(request: ServerCall): ServerRequestEvent {
  if (request.method === "item/tool/requestUserInput") {
    const params = request.params as ToolRequestUserInputParams
    if (params && typeof params.threadId === "string" && typeof params.turnId === "string" && typeof params.itemId === "string" && Array.isArray(params.questions)) {
      return {
        type: "userInput.requested", requestId: request.id, threadId: threadId(params.threadId), turnId: turnId(params.turnId),
        itemId: itemId(params.itemId), isBlocking: params.isBlocking,
        questions: params.questions.map(question => ({
          id: question.id, header: question.header, question: question.question,
          allowOther: question.isOther, secret: question.isSecret, ...(question.options ? { options: question.options } : {}),
        })),
      }
    }
  }
  const approval = mapApproval(request)
  return approval
    ? { type: "approval.requested", requestId: request.id, method: request.method, approval }
    : { type: "unknown", method: request.method, payload: request.params }
}

function mapApproval(request: ServerCall): Approval | undefined {
  const requestId = `${typeof request.id}:${String(request.id)}`
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const params = request.params as CommandExecutionRequestApprovalParams
      if (!params || typeof params.threadId !== "string") return undefined
      return {
        id: requestId, threadId: threadId(params.threadId), turnId: turnId(params.turnId), kind: "command",
        title: params.kind === "writeStdin" ? "Send input to command" : params.command || "Run command",
        detail: [params.reason, params.cwd].filter(Boolean).join("\n"), choices: commandChoices(params.availableDecisions), status: "pending",
      }
    }
    case "item/fileChange/requestApproval": {
      const params = request.params as FileChangeRequestApprovalParams
      if (!params || typeof params.threadId !== "string") return undefined
      return { id: requestId, threadId: threadId(params.threadId), turnId: turnId(params.turnId), kind: "file-change", title: "Apply file changes", detail: [params.reason, params.grantRoot].filter(Boolean).join("\n"), choices: defaultDecisionChoices, status: "pending" }
    }
    case "item/permissions/requestApproval": {
      const params = request.params as PermissionsRequestApprovalParams
      if (!params || typeof params.threadId !== "string") return undefined
      return {
        id: requestId, threadId: threadId(params.threadId), turnId: turnId(params.turnId), kind: "permissions", title: "Grant additional permissions",
        detail: [params.reason, params.cwd, safeStringify(params.permissions)].filter(Boolean).join("\n"),
        choices: [{ id: "grant-turn", label: "Grant for turn" }, { id: "grant-session", label: "Grant for session" }, { id: "decline", label: "Decline" }], status: "pending",
      }
    }
    case "execCommandApproval": {
      const params = request.params as ExecCommandApprovalParams
      if (!params || typeof params.conversationId !== "string") return undefined
      return { id: requestId, threadId: threadId(params.conversationId), kind: "legacy", title: params.command.join(" "), detail: [params.reason, params.cwd].filter(Boolean).join("\n"), choices: legacyDecisionChoices, status: "pending" }
    }
    case "applyPatchApproval": {
      const params = request.params as ApplyPatchApprovalParams
      if (!params || typeof params.conversationId !== "string") return undefined
      return { id: requestId, threadId: threadId(params.conversationId), kind: "legacy", title: "Apply patch", detail: [params.reason, ...Object.keys(params.fileChanges)].filter(Boolean).join("\n"), choices: legacyDecisionChoices, status: "pending" }
    }
  }
}

const defaultDecisionChoices: readonly ApprovalChoice[] = [
  { id: "accept", label: "Accept" }, { id: "decline", label: "Decline" }, { id: "cancel", label: "Cancel turn" },
]
const legacyDecisionChoices: readonly ApprovalChoice[] = [
  { id: "approved", label: "Approve" }, { id: "approved_for_session", label: "Approve for session" },
  { id: "denied", label: "Deny" }, { id: "abort", label: "Abort" },
]
function commandChoices(decisions: CommandExecutionRequestApprovalParams["availableDecisions"]): readonly ApprovalChoice[] {
  if (!decisions?.length) return defaultDecisionChoices
  return decisions.map(decision => {
    if (typeof decision === "string") return { id: decision, label: labelDecision(decision) }
    return { id: JSON.stringify(decision), label: "acceptWithExecpolicyAmendment" in decision ? "Accept with command policy change" : "Apply network policy change" }
  })
}
function labelDecision(decision: string): string {
  switch (decision) {
    case "accept": return "Accept"
    case "acceptForSession": return "Accept for session"
    case "decline": return "Decline"
    case "cancel": return "Cancel turn"
    default: return decision
  }
}

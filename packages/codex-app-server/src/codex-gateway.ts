import { createHash } from "node:crypto"
import {
  createCodexAppServerClient,
  type CodexAppServerClient,
} from "./capabilities/codex-app-server-client"
import { CodexApprovalGateway } from "./codex-approval-gateway"
import { hydrateTurns } from "./mapping/map-item"
import {
  itemId,
  type MentionCandidate,
  type MentionSearchKind,
  type ConversationGateway,
  type ConversationInput,
} from "@vimex/conversation"
import type { UserInput } from "./generated/v0_154_0/v2/UserInput"
import { open, readdir, readFile, stat } from "node:fs/promises"
import { resolve, posix } from "node:path"
import {
  createMachineCodexClient,
  type CodexMachine,
} from "./transport/machine-transport"
import {
  remotePath,
  remoteWorkspaceEntries,
  readRemoteText,
} from "./remote-workspace"

export interface CodexGatewayOptions {
  machine?: CodexMachine
  reconnect?: {
    initialDelayMs?: number
    maxDelayMs?: number
    maxAttempts?: number
  }
}

const mentionPreviewLimit = 4096
const mentionSearchFileLimit = 2 * 1024 * 1024
const mentionResultLimit = 50

async function workspaceEntries(
  root: string,
  signal?: AbortSignal,
): Promise<{ path: string; match_type: "file" | "directory" }[]> {
  const files: { path: string; match_type: "file" | "directory" }[] = []
  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
  ])
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      signal?.throwIfAborted()
      return
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        files.push({ path, match_type: "directory" })
        await visit(path)
      } else if (entry.isFile()) files.push({ path, match_type: "file" })
    }
  }
  await visit(resolve(root))
  signal?.throwIfAborted()
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function readMentionPreview(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  try {
    const file = await open(path, "r")
    try {
      signal?.throwIfAborted()
      if (!(await file.stat()).isFile()) return undefined
      const buffer = Buffer.alloc(mentionPreviewLimit)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      signal?.throwIfAborted()
      // File pickers can enumerate binary assets too. Avoid sending binary
      // control data into the terminal preview while keeping their attachment.
      if (buffer.subarray(0, bytesRead).includes(0)) return undefined
      return buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await file.close()
    }
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

function normalizeConversationInput(
  text: string,
  input?: readonly ConversationInput[],
): string | UserInput[] {
  if (!input?.length) return text
  const parts: UserInput[] = []
  for (const part of input) {
    // Codex mentions select apps/plugins; they do not put filesystem paths
    // into the model's input. Keep file/directory references in literal text.
    if (part.type === "text" || part.type === "file") {
      const value = part.type === "file" ? `@${part.path}` : part.text
      const previous = parts.at(-1)
      if (previous?.type === "text") previous.text += value
      else parts.push({ type: "text", text: value, text_elements: [] })
    } else if (part.type === "image") {
      parts.push({ type: "localImage", path: part.path })
    } else {
      parts.push({ type: part.type, name: part.name, path: part.path })
    }
  }
  return parts
}
import type {
  RuntimeEvent,
  RuntimeConnection,
  ModelCatalog,
} from "@vimex/workbench"

/** Adapts one Codex connection to the application-owned capability ports. */
export function createCodexGateways(
  cwd: string,
  executable = "codex",
  clientFactory?: () => CodexAppServerClient,
  options: CodexGatewayOptions = {},
) {
  const createClient =
    clientFactory ??
    (() =>
      options.machine
        ? createMachineCodexClient(cwd, {
            ...options.machine,
            executable: options.machine.executable ?? executable,
          })
        : createCodexAppServerClient(
            { cwd, command: executable },
            { experimentalApi: true },
          ))
  let client = createClient()
  let detachClient = () => {}
  let closed = false
  let restartPromise: Promise<void> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0
  let reconnectError: string | undefined
  let connecting = false
  let established = false
  let connectPromise: Promise<void> | undefined
  let disconnectRevision = 0
  const remote = Boolean(options.machine?.sshHost)
  const reconnectEnabled = Boolean(
    options.machine && options.machine.mode !== "stdio",
  )
  const scheduleReconnect = () => {
    if (
      closed ||
      connecting ||
      restartPromise ||
      reconnectTimer ||
      !reconnectEnabled
    )
      return
    const maxAttempts = options.reconnect?.maxAttempts ?? 10
    if (reconnectAttempt >= maxAttempts) {
      publish({
        type: "notice",
        message: `Unable to reconnect to Codex${reconnectError ? `: ${reconnectError}` : ""}; use :restart to try again. Unacknowledged submissions were not resent.`,
      })
      return
    }
    const delay = Math.min(
      options.reconnect?.maxDelayMs ?? 15_000,
      (options.reconnect?.initialDelayMs ?? 250) * 2 ** reconnectAttempt++,
    )
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void restart()
        .then(() => {
          reconnectAttempt = 0
          reconnectError = undefined
          if (!closed) publish({ type: "reconnected" })
        })
        .catch((error) => {
          reconnectError = String(error).slice(0, 1000)
          scheduleReconnect()
        })
    }, delay)
  }
  const ephemeralSideThreads = new Set<string>()
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const publish = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event)
  }
  const approvals = new CodexApprovalGateway(() => client)

  const receive = (
    event: Parameters<Parameters<CodexAppServerClient["onEvent"]>[0]>[0],
  ) => {
    const approvalEvents = approvals.handle(event)
    if (approvalEvents) {
      for (const normalized of approvalEvents) publish(normalized)
      return
    }
    let normalized: RuntimeEvent | undefined
    switch (event.type) {
      case "subagent.link":
        normalized = {
          type: "subagent.link",
          link: {
            parentId: event.link.ownerThreadId,
            childId: event.link.agentThreadId,
            itemId: event.link.itemId,
            relation: event.link.relation,
            agentPath: event.link.agentPath,
          },
        }
        break
      case "conversation":
        normalized = event
        break
      case "compaction":
        normalized = event
        break
      case "thread.summary":
        normalized = { type: "summary", summary: event.summary }
        break
      case "thread.name":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { title: event.name, titleSource: "name" },
        }
        break
      case "thread.goal":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { goal: event.goal },
        }
        break
      case "thread.status":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { status: event.status },
        }
        break
      case "thread.tokenUsage":
        normalized = {
          type: "metadata",
          threadId: event.threadId,
          patch: { contextUsed: event.used, contextLimit: event.contextLimit },
        }
        break
      case "error":
        if (event.threadId && !event.willRetry)
          publish({
            type: "compaction",
            phase: "failed",
            threadId: event.threadId,
            turnId: event.turnId,
            error: event.message,
          })
        normalized = { type: "notice", message: event.message }
        break
      case "warning":
        normalized = { type: "notice", message: event.message }
        break
      case "connection":
        if (event.status !== "connected") {
          established = false
          disconnectRevision++
          normalized = {
            type: "disconnected",
            message: event.error ?? "Codex app server disconnected",
          }
          scheduleReconnect()
        }
        break
      case "unknown":
        break
      case "approval.requested":
      case "approval.resolved":
      case "approval.cancelled":
      case "userInput.requested":
        break
    }
    if (normalized) publish(normalized)
  }
  const attach = () => {
    detachClient()
    detachClient = client.onEvent(receive)
  }
  attach()

  const connectClient = async () => {
    connecting = true
    const revision = disconnectRevision
    try {
      await client.connect()
      if (closed || revision !== disconnectRevision)
        throw new Error("Codex disconnected during initialization")
      established = true
    } finally {
      connecting = false
    }
  }
  const restart = async () => {
    if (closed) throw new Error("Codex runtime connection is closed")
    if (restartPromise) return restartPromise
    if (connectPromise) await connectPromise.catch(() => {})
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    const operation = (async () => {
      publish({
        type: "disconnected",
        message: reconnectEnabled
          ? "Reconnecting to Codex app server"
          : "Restarting Codex app server",
        reason: "restart",
      })
      for (const event of approvals.invalidatePending()) publish(event)
      established = false
      const previous = client
      // Its intentional shutdown must not invalidate the replacement connection.
      detachClient()
      try {
        await previous.close()
      } catch (error) {
        publish({
          type: "notice",
          message: `Failed to close previous Codex app server: ${String(error)}`,
        })
      } finally {
        detachClient()
      }
      if (closed) return
      client = createClient()
      if (!reconnectEnabled) ephemeralSideThreads.clear()
      attach()
      await connectClient()
    })()
    const tracked = operation.finally(() => {
      if (restartPromise === tracked) restartPromise = undefined
      if (!established) scheduleReconnect()
    })
    restartPromise = tracked
    return tracked
  }

  const connection: RuntimeConnection = {
    connect: async () => {
      if (closed) throw new Error("Codex runtime connection is closed")
      if (restartPromise) return restartPromise
      if (established) return
      if (!connectPromise) {
        const pending = connectClient()
          .then(() => {
            reconnectAttempt = 0
          })
          .finally(() => {
            if (connectPromise === pending) connectPromise = undefined
            if (!established) scheduleReconnect()
          })
        connectPromise = pending
      }
      return connectPromise
    },
    restart,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      if (closed) return
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      await restartPromise?.catch(() => {})
      try {
        await client.close()
      } finally {
        detachClient()
        listeners.clear()
      }
    },
  }
  const observeSession = <
    T extends Awaited<ReturnType<CodexAppServerClient["resumeThread"]>>,
  >(
    session: T,
  ): T => {
    if (session.relation.parentThreadId)
      publish({
        type: "subagent.link",
        link: {
          parentId: session.relation.parentThreadId,
          childId: session.relation.threadId,
          itemId: itemId(`thread:${session.relation.threadId}`),
          relation: "spawned",
        },
      })
    return session
  }
  const entriesFor = (path: string, signal?: AbortSignal) =>
    remote
      ? remoteWorkspaceEntries(client, path, signal)
      : workspaceEntries(path, signal)
  const prepareInput = async (
    text: string,
    input?: readonly ConversationInput[],
  ) => {
    if (!remote || !input?.some((part) => part.type === "image"))
      return normalizeConversationInput(text, input)
    const source = client
    const codexHome = source.serverInfo?.codexHome
    if (!codexHome)
      throw new Error("Connect to the remote machine before attaching images")
    const directory = posix.join(codexHome, "vimex-attachments")
    await source.createHostDirectory(directory)
    const prepared: ConversationInput[] = []
    for (const part of input) {
      if (part.type !== "image") {
        prepared.push(part)
        continue
      }
      const metadata = await stat(part.path)
      if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024)
        throw new Error("Image attachment must be a file smaller than 20 MiB")
      const destination = posix.join(
        directory,
        `${crypto.randomUUID()}${posix.extname(part.path)}`,
      )
      await source.writeHostFile(
        destination,
        (await readFile(part.path)).toString("base64"),
      )
      if (source !== client)
        throw new Error(
          "Connection changed while uploading image; submit again after reconnect",
        )
      prepared.push({ ...part, path: destination })
    }
    return normalizeConversationInput(text, prepared)
  }
  const conversation: ConversationGateway = {
    readMentionPreview: (path, signal) =>
      remote
        ? readRemoteText(client, path, 2 * 1024 * 1024, signal).then((text) =>
            text?.slice(0, mentionPreviewLimit),
          )
        : readMentionPreview(path, signal),
    async listBackgroundTerminals(id) {
      const terminals = await client.listBackgroundTerminals(id)
      return terminals.map((terminal) => ({
        threadId: id,
        itemId: itemId(terminal.itemId),
        processId: terminal.processId,
        command: terminal.command,
        cwd: terminal.cwd,
        osPid: terminal.osPid,
        cpuPercent: terminal.cpuPercent,
        rssKb: terminal.rssKb === null ? null : Number(terminal.rssKb),
      }))
    },
    terminateBackgroundTerminal: (id, processId) =>
      client.terminateBackgroundTerminal(id, processId),
    compactThread: (id) => client.compactThread(id),
    shellCommand: (id, command) => client.shellCommand(id, command),
    async getGoal(id) {
      const goal = await client.getGoal(id)
      publish({ type: "metadata", threadId: id, patch: { goal } })
      return goal
    },
    async setGoal(id, update) {
      const goal = await client.setGoal(id, update)
      publish({ type: "metadata", threadId: id, patch: { goal } })
      return goal
    },
    async clearGoal(id) {
      const cleared = await client.clearGoal(id)
      publish({ type: "metadata", threadId: id, patch: { goal: null } })
      return cleared
    },
    async forkSideThread(id) {
      const fork = await client.forkThread(id, undefined, {
        ephemeral: true,
        excludeTurns: true,
      })
      ephemeralSideThreads.add(fork.summary.id)
      // Ephemeral forks cannot inherit a persisted goal. Mark inherited history
      // as reference context before the first side turn.
      try {
        await client.injectItems({
          threadId: fork.summary.id,
          items: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Side conversation boundary. The inherited history is reference context only. Do not continue the parent's active task or goal. Only requests submitted after this boundary are active instructions for this side conversation.",
                },
              ],
            },
          ],
        })
      } catch (error) {
        await client.unsubscribeThread(fork.summary.id)
        ephemeralSideThreads.delete(fork.summary.id)
        throw error
      }
      return observeSession(fork)
    },
    async retireThread(id) {
      if (ephemeralSideThreads.has(id)) {
        await client.unsubscribeThread(id)
        ephemeralSideThreads.delete(id)
      } else await client.archiveThread(id)
    },
    async listAgentThreads(root) {
      const all = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await client.listThreads({
          cursor,
          limit: 100,
          useStateDbOnly: true,
          sourceKinds: ["subAgentThreadSpawn"],
          ancestorThreadId: root,
        })
        all.push(...page.threads)
        cursor = page.nextCursor ?? undefined
        if (cursor && seen.has(cursor))
          throw new Error(
            "Codex agent catalog returned a repeated pagination cursor",
          )
        if (cursor) seen.add(cursor)
      } while (cursor)
      return all
    },
    async listThreads(onPage) {
      const all = []
      let cursor: string | undefined
      let useStateDbOnly = true
      do {
        const page = await client.listThreads({
          cursor,
          limit: 25,
          useStateDbOnly,
        })
        // Match Codex's indexed-first lookup. An empty initial index may need
        // rollout discovery; keep subsequent cursors in the same listing mode.
        if (!cursor && useStateDbOnly && page.threads.length === 0) {
          useStateDbOnly = false
          continue
        }
        const childIds = new Set(
          page.relations
            .filter((relation) => relation.parentThreadId)
            .map((relation) => relation.threadId),
        )
        const visible = page.threads.filter(
          (thread) => !childIds.has(thread.id),
        )
        all.push(...visible)
        onPage?.(visible)
        cursor = page.nextCursor ?? undefined
        if (!cursor) break
      } while (true)
      return all
    },
    async searchMentions(
      query: string,
      kind: MentionSearchKind,
      cwd: string,
      signal?: AbortSignal,
    ): Promise<readonly MentionCandidate[]> {
      signal?.throwIfAborted()
      if (kind === "grep") {
        if (!query.trim()) return []
        let matcher: RegExp
        try {
          matcher = new RegExp(query)
        } catch {
          matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        }
        const matches = []
        for (const entry of await entriesFor(cwd, signal)) {
          signal?.throwIfAborted()
          if (entry.match_type !== "file") continue
          const { path } = entry
          if (matches.length >= mentionResultLimit) break
          let contents: string
          try {
            if (remote) {
              const text = await readRemoteText(
                client,
                path,
                mentionSearchFileLimit,
                signal,
              )
              if (text === undefined) continue
              contents = text
            } else {
              if ((await stat(path)).size > mentionSearchFileLimit) continue
              signal?.throwIfAborted()
              contents = await readFile(path, { encoding: "utf8", signal })
            }
          } catch {
            signal?.throwIfAborted()
            continue
          }
          signal?.throwIfAborted()
          const lines = contents.split("\n")
          const lineNumber = lines.findIndex((line) => {
            matcher.lastIndex = 0
            return matcher.test(line)
          })
          if (lineNumber < 0) continue
          const relativePath = path.slice(
            (remote ? remotePath(cwd, ".") : resolve(cwd)).length + 1,
          )
          matches.push({
            kind: "file" as const,
            name: relativePath,
            path,
            detail: `${lineNumber + 1}: ${lines[lineNumber]!.trim()}`,
          })
        }
        return matches
      }
      if (kind === "file") {
        // The app-server fuzzy endpoint is intentionally bounded. An empty
        // query is the modal's initial state, so enumerate the workspace
        // directly to make files and directories searchable. Non-empty queries can use
        // the server's indexed search and only need the visible matches.
        const files = query.trim()
          ? (
              await client.fuzzyFileSearch({
                query,
                roots: [cwd],
                cancellationToken: null,
              })
            ).files
          : (await entriesFor(cwd, signal)).map(({ path, match_type }) => ({
              root: cwd,
              path,
              match_type,
              file_name: path.split(/[\\/]/u).pop() ?? path,
              score: 0,
              indices: null,
            }))
        signal?.throwIfAborted()
        return files.map((file) => {
          const path = remote
            ? remotePath(file.root, file.path)
            : resolve(file.root, file.path)
          const directory = file.match_type === "directory"
          const candidate = {
            kind,
            name: directory
              ? `${file.path.replace(/[\\/]+$/u, "")}/`
              : file.path,
            path,
            detail: directory ? "Directory" : file.file_name,
          }
          return candidate
        })
      }
      if (kind === "skill") {
        const result = await client.listSkills({ cwds: [cwd] })
        signal?.throwIfAborted()
        return result.data
          .flatMap((entry) => entry.skills)
          .filter(
            (skill) =>
              skill.enabled &&
              (!query ||
                `${skill.name} ${skill.description}`
                  .toLowerCase()
                  .includes(query.toLowerCase())),
          )
          .slice(0, 50)
          .map((skill) => ({
            kind,
            name: skill.name,
            path: skill.path,
            detail: skill.description,
          }))
      }
      const result = await client.listPlugins({ cwds: [cwd] })
      signal?.throwIfAborted()
      return result.marketplaces
        .flatMap((marketplace) => marketplace.plugins)
        .filter(
          (plugin) =>
            plugin.enabled &&
            (!query ||
              `${plugin.name} ${plugin.keywords.join(" ")}`
                .toLowerCase()
                .includes(query.toLowerCase())),
        )
        .slice(0, 50)
        .map((plugin) => ({
          kind,
          name: plugin.name,
          path: plugin.id,
          detail: plugin.interface?.shortDescription ?? undefined,
        }))
    },
    async startThread(cwd, model) {
      return observeSession(
        await client.startThread({ cwd, ...(model ? { model } : {}) }),
      )
    },
    async resumeThread(id) {
      return observeSession(await client.resumeThread(id))
    },
    async forkThread(id, through) {
      return observeSession(await client.forkThread(id, through))
    },
    async startTurn(id, text, clientMessageId, input, onRequestSent) {
      const response = await client.startTurn(
        id,
        await prepareInput(text, input),
        {
          clientUserMessageId: clientMessageId,
        },
        onRequestSent,
      )
      return hydrateTurns([response.turn], id)
    },
    async steerTurn(id, turn, text, clientMessageId, input, onRequestSent) {
      await client.steerTurn(
        id,
        turn,
        await prepareInput(text, input),
        {
          clientUserMessageId: clientMessageId,
        },
        onRequestSent,
      )
    },
    async interruptTurn(id, turn) {
      await client.interruptTurn(id, turn)
    },
    async renameThread(id, name) {
      await client.renameThread(id, name)
    },
    async updateSettings(id, settings) {
      await client.updateThreadSettings(id, settings)
    },
  }
  const accountStatus = async (): Promise<string> => {
    const [limits, usage] = await Promise.all([
      client.getAccountRateLimits(),
      client.getAccountUsage(),
    ])
    const formatWindow = (
      label: string,
      window: { usedPercent: number; resetsAt: number | null } | null,
    ) =>
      window
        ? `${label} ${window.usedPercent.toFixed(1)}% used${window.resetsAt ? ` (resets ${new Date(window.resetsAt * 1000).toLocaleString()})` : ""}`
        : undefined
    const snapshot = limits.rateLimits
    const windows = [
      formatWindow("Primary", snapshot.primary),
      formatWindow("Secondary", snapshot.secondary),
    ].filter((value): value is string => Boolean(value))
    const tokens = usage.summary.lifetimeTokens
    return (
      [
        limits.accountId ? `Account ${limits.accountId}` : undefined,
        snapshot.planType ? `Plan ${snapshot.planType}` : undefined,
        ...windows,
        tokens === null ? undefined : `Lifetime tokens ${tokens.toString()}`,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || "Account usage unavailable"
    )
  }
  const models: ModelCatalog = {
    async listModels() {
      // Keep every page on one connection, even if the runtime restarts mid-list.
      const source = client
      const all: Awaited<ReturnType<ModelCatalog["listModels"]>>[number][] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await source.listModels({ cursor, limit: 100 })
        all.push(
          ...page.models.map((model) => ({
            id: model.model,
            label: model.label,
            efforts: model.supportedReasoningEfforts.map((e) => e.effort),
          })),
        )
        cursor = page.nextCursor ?? undefined
        if (cursor && seen.has(cursor))
          throw new Error(
            "Codex model catalog returned a repeated pagination cursor",
          )
        if (cursor) seen.add(cursor)
      } while (cursor)
      return all
    },
  }
  const readNativeThread = async (id: string) => {
    try {
      return await client.readThread(id)
    } catch (error) {
      if (!/thread not loaded/i.test(String(error))) throw error
      // A metadata-only read in 0.166 cannot always distinguish an unloaded
      // rollout from a missing ID. Ask the native listing scanner to repair
      // metadata; do not mistake an unloaded existing thread for a free ID.
      for (const archived of [false, true]) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await client.listThreads({
            archived,
            cursor,
            limit: 100,
            modelProviders: [],
            useStateDbOnly: false,
            sourceKinds: [
              "cli",
              "vscode",
              "exec",
              "appServer",
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
              "unknown",
            ],
          })
          const thread = page.raw.data.find((thread) => thread.id === id)
          if (thread) return { thread }
          cursor = page.nextCursor ?? undefined
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 1000)
              throw new Error("Native session lookup exceeded its bounded scan")
            seen.add(cursor)
          }
        } while (cursor)
      }
      throw new Error(`No rollout found for thread id ${id}`)
    }
  }
  const nativeHandoff = {
    serverDetails() {
      const info = client.serverInfo
      if (!info?.codexHome)
        throw new Error(
          "App server did not report its native session directory",
        )
      const version = /(?:^|\/)(\d+\.\d+\.\d+)(?:\s|$)/.exec(
        info.userAgent,
      )?.[1]
      if (!version)
        throw new Error(
          "Unable to determine the running app-server version for native handoff",
        )
      return { codexHome: info.codexHome, version }
    },
    async locate(id: string): Promise<string | undefined> {
      try {
        return (await readNativeThread(id)).thread.path ?? undefined
      } catch (error) {
        if (
          /no rollout found|thread[^\n]*not found|thread[^\n]*does not exist/i.test(
            String(error),
          )
        )
          return undefined
        throw error
      }
    },
    async isArchived(id: string): Promise<boolean> {
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await client.listThreads({
          archived: true,
          cursor,
          limit: 100,
          modelProviders: [],
          useStateDbOnly: false,
          sourceKinds: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
        })
        if (page.raw.data.some((thread) => thread.id === id)) return true
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 1000)
            throw new Error("Archived session lookup exceeded its bounded scan")
          seen.add(cursor)
        }
      } while (cursor)
      return false
    },
    async ownedDescendants(id: string): Promise<readonly string[]> {
      const ids = new Set<string>()
      for (const archived of [false, true]) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await client.listThreads({
            archived,
            cursor,
            limit: 100,
            ancestorThreadId: id,
            modelProviders: [],
            useStateDbOnly: false,
            sourceKinds: [
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
            ],
          })
          for (const child of page.raw.data) ids.add(child.id)
          if (ids.size > 64)
            throw new Error("Native agent subtree exceeds handoff limits")
          cursor = page.nextCursor ?? undefined
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 1000)
              throw new Error("Native subtree catalog did not advance")
            seen.add(cursor)
          }
        } while (cursor)
      }
      return [...ids]
    },
    async referencedThreads(id: string): Promise<readonly string[]> {
      const references = new Set<string>()
      const add = (value: unknown) => {
        if (typeof value !== "string" || !value)
          throw new Error(
            "Native collaboration history contains an invalid thread reference",
          )
        if (value !== id) references.add(value)
        if (references.size > 64)
          throw new Error(
            "Session collaboration graph exceeds the 64-thread handoff limit",
          )
      }
      const thread = (await readNativeThread(id)).thread
      if (thread.parentThreadId) add(thread.parentThreadId)
      for (const archived of [false, true]) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await client.listThreads({
            archived,
            cursor,
            limit: 100,
            parentThreadId: id,
            modelProviders: [],
            useStateDbOnly: false,
            sourceKinds: [
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
            ],
          })
          for (const child of page.raw.data) add(child.id)
          cursor = page.nextCursor ?? undefined
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 1000)
              throw new Error("Native child catalog did not advance")
            seen.add(cursor)
          }
        } while (cursor)
      }
      let cursor: string | undefined
      const seen = new Set<string>()
      let bytes = 0
      do {
        const page = await client.listTurns({
          threadId: id,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "full",
        })
        bytes += Buffer.byteLength(JSON.stringify(page.data))
        if (bytes > 64 * 1024 * 1024)
          throw new Error("Collaboration history exceeds handoff limits")
        for (const turn of page.data)
          for (const item of turn.items) {
            if (item.type === "collabAgentToolCall") {
              item.receiverThreadIds.forEach(add)
              Object.keys(item.agentsStates ?? {}).forEach(add)
            } else if (item.type === "subAgentActivity") add(item.agentThreadId)
          }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 10000)
            throw new Error("Collaboration history pagination did not advance")
          seen.add(cursor)
        }
      } while (cursor)
      return [...references]
    },
    async resumeTree(sourceId: string, path: string, cwd: string) {
      return observeSession(
        await client.resumeThread(sourceId, {
          path,
          cwd,
          runtimeWorkspaceRoots: [cwd],
        }),
      )
    },
    async unarchiveTree(id: string) {
      return (await client.unarchiveThread(id)).thread.path
    },
    async assertPortable(id: string, checkGoal = true) {
      const { thread } = await readNativeThread(id)
      if (!["idle", "notLoaded"].includes(thread.status.type))
        throw new Error(
          `Session ${id} is active; wait for its work to finish before handoff`,
        )
      if (checkGoal && (await client.getGoal(id)))
        throw new Error(
          `Session ${id} has a persisted goal. Clear its goal before handoff; native goal usage cannot yet be transferred exactly`,
        )
    },
    async hydrateHistory(id: string, cwd: string) {
      // A persistent resume appends destination context to the imported
      // bytes, breaking future ancestry-prefix identity on a round trip.
      // An ephemeral fork builds Codex's native projections without rewriting
      // the imported checkpoint or leaving another persisted conversation.
      const fork = await client.forkThread(id, undefined, {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        ephemeral: true,
        excludeTurns: true,
      })
      await client.unsubscribeThread(fork.summary.id)
    },
    async historyDigest(id: string): Promise<string> {
      const normalize = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(normalize)
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)]),
          )
        return value
      }
      const digest = createHash("sha256")
      const seen = new Set<string>()
      let cursor: string | undefined
      let bytes = 0
      let count = 0
      do {
        const page = await client.listTurns({
          threadId: id,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "full",
        })
        for (const turn of page.data) {
          const value = JSON.stringify(normalize(turn))
          bytes += Buffer.byteLength(value)
          if (++count > 100000 || bytes > 64 * 1024 * 1024)
            throw new Error(
              "Session history exceeds handoff verification limits",
            )
          digest.update(value).update("\n")
        }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (seen.has(cursor) || seen.size > 10000)
            throw new Error("Native history pagination did not advance")
          seen.add(cursor)
        }
      } while (cursor)
      return `${count}:${digest.digest("hex")}`
    },
    async accountIdentity(): Promise<string> {
      const source = client
      const { account } = await source.readAccount()
      if (account?.type !== "chatgpt")
        throw new Error(
          "Native handoff requires an identifiable ChatGPT account on both machines",
        )
      const { accountId } = await source.getAccountRateLimits()
      if (!accountId || !account.email?.trim())
        throw new Error("Unable to verify account identity for native handoff")
      if (source !== client)
        throw new Error("Connection changed while verifying handoff identity")
      // Compare only in memory; never write identity into transfer manifests.
      return JSON.stringify([
        "chatgpt",
        accountId,
        account.email.trim().toLowerCase(),
      ])
    },
    archiveSource: (id: string) => client.archiveThread(id),
    async inspect(id: string) {
      const { thread } = await readNativeThread(id)
      if (!thread.path)
        throw new Error("This conversation has no transferable rollout")
      return {
        threadId: thread.id,
        rolloutPath: thread.path,
        cwd: thread.cwd,
        parentThreadId: thread.parentThreadId,
        sessionId: thread.sessionId,
        historyMode: thread.historyMode,
        status: thread.status,
        model: thread.model,
        modelProvider: thread.modelProvider,
        cliVersion: thread.cliVersion,
        serverUserAgent: client.serverInfo?.userAgent,
      }
    },
    async forkFromPath(sourceId: string, path: string, destinationCwd: string) {
      // Do not copy raw history through the cloud-only history parameter. Let
      // Codex read and validate its native checkpoint; no model turn is started.
      return observeSession(
        await client.forkThread(sourceId, undefined, {
          path,
          cwd: destinationCwd,
          runtimeWorkspaceRoots: [destinationCwd],
          deferGoalContinuation: true,
        }),
      )
    },
  }
  return {
    connection,
    conversation,
    approvals,
    models,
    accountStatus,
    serverInfo: () => client.serverInfo,
    nativeHandoff,
  }
}

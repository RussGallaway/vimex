import { createHash } from "node:crypto"
import { posix } from "node:path"
import { hostOperation, type MachineHost } from "./host"
import { validateLegacyRollout } from "./legacy-handoff"

const maxBytes = 64 * 1024 * 1024
const maxFiles = 64
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)
function ordinalAt(data: Buffer, bytes: number): number {
  const lines = data
    .subarray(0, bytes)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
  const base =
    JSON.parse(lines[0]!).payload?.history_base?.end_ordinal_exclusive ?? 0
  if (!Number.isSafeInteger(base) || base < 0)
    throw new Error("Native history dependency has an invalid base ordinal")
  return base + lines.length
}
export interface HistoryFile {
  id: string
  path: string
  data: Buffer
  requiredBytes: number
  requiredOrdinal?: number
  /** Selected sessions and collaboration references require their complete histories. */
  complete?: boolean
}
export interface HistoryBundle {
  files: HistoryFile[]
  threadId: string
  hasSubagents?: boolean
  verifySourceUnchanged(): Promise<void>
}

/** Native bytes are authoritative. Collaboration links may cycle; ancestry may not. */
export async function captureHistoryBundle(
  source: MachineHost,
  threadId: string,
  locate: (id: string) => Promise<string>,
  discover?: (id: string) => Promise<readonly string[]>,
): Promise<HistoryBundle> {
  type Cutoff = { bytes: number; ordinal: number }
  type Request = { id: string; complete: boolean; cutoffs: Cutoff[] }
  const requests = new Map<string, Request>()
  const pending: Request[] = []
  const found = new Map<string, HistoryFile>()
  const ancestry = new Map<string, string[]>()
  let total = 0
  let containsSubagents = false
  const read = async (path: string) =>
    Buffer.from(
      (await hostOperation(source, { action: "read", path })).data,
      "base64",
    )
  const requireCutoff = (file: HistoryFile, required: Cutoff) => {
    const prefix = file.data.subarray(0, required.bytes)
    if (
      !Number.isSafeInteger(required.bytes) ||
      required.bytes <= 0 ||
      required.bytes > file.data.length ||
      !Number.isSafeInteger(required.ordinal) ||
      required.ordinal < 1 ||
      prefix.at(-1) !== 10 ||
      ordinalAt(file.data, required.bytes) !== required.ordinal
    )
      throw new Error(
        "Native history dependency has an invalid or repeated cutoff",
      )
    if (required.bytes > file.requiredBytes) {
      file.requiredBytes = required.bytes
      file.requiredOrdinal = required.ordinal
    }
  }
  const enqueue = (id: string, complete: boolean, cutoff?: Cutoff) => {
    if (!validId(id))
      throw new Error("Unsupported native history dependency ID")
    let request = requests.get(id)
    if (!request) {
      if (requests.size >= maxFiles)
        throw new Error("Session history exceeds the 64-file handoff limit")
      request = { id, complete, cutoffs: [] }
      requests.set(id, request)
      pending.push(request)
    } else request.complete ||= complete
    if (cutoff) request.cutoffs.push(cutoff)
    const file = found.get(id)
    if (file) {
      if (cutoff) requireCutoff(file, cutoff)
      if (complete) {
        file.complete = true
        file.requiredBytes = file.data.length
      }
    }
  }
  enqueue(threadId, true)
  while (pending.length) {
    const request = pending.shift()!
    const path = await locate(request.id)
    if (!posix.isAbsolute(path))
      throw new Error("Native history path must be absolute")
    const data = await read(path)
    total += data.length
    if (total > maxBytes)
      throw new Error("Session history exceeds the 64 MiB handoff limit")
    validateLegacyRollout(data.toString("utf8"), request.id, true)
    const records = data
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    // Discovery must use native thread metadata and typed collaboration items.
    // Without that adapter, accepting a marker would silently omit children.
    const hasSubagents = records.some((record) => {
      const payload = record.payload
      return record.type === "session_meta"
        ? payload?.source?.subagent !== undefined ||
            payload?.source?.subAgent !== undefined ||
            payload?.subagent_history_start_ordinal != null
        : payload?.type?.startsWith?.("collab_agent_") ||
            [
              "spawn_agent",
              "functions.spawn_agent",
              "collaboration.spawn_agent",
            ].includes(payload?.name)
    })
    containsSubagents ||= hasSubagents
    if (hasSubagents && !discover)
      throw new Error(
        "This session has subagent history; native dependency discovery is required",
      )
    const file: HistoryFile = {
      id: request.id,
      path,
      data,
      complete: request.complete,
      requiredBytes: request.complete ? data.length : 0,
    }
    found.set(file.id, file)
    for (const cutoff of request.cutoffs) requireCutoff(file, cutoff)
    const bases: string[] = []
    for (const record of records) {
      if (record.type !== "session_meta") continue
      const base = record.payload?.history_base
      if (!base) continue
      if (
        typeof base.thread_id !== "string" ||
        typeof base.end_byte_offset !== "number" ||
        typeof base.end_ordinal_exclusive !== "number"
      )
        throw new Error(
          "Native history dependency lacks a portable byte/record cutoff",
        )
      if (base.thread_id === file.id)
        throw new Error("Native history contains a dependency cycle")
      bases.push(base.thread_id)
      enqueue(base.thread_id, false, {
        bytes: base.end_byte_offset,
        ordinal: base.end_ordinal_exclusive,
      })
    }
    ancestry.set(file.id, bases)
    const references = (await discover?.(file.id)) ?? []
    containsSubagents ||= references.length > 0
    for (const id of references) enqueue(id, true)
  }
  // Hydrate parents before dependent histories. Parent/child collaboration
  // references intentionally do not participate in this DAG ordering.
  const files: HistoryFile[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order = (id: string) => {
    if (visiting.has(id))
      throw new Error("Native history contains a dependency cycle")
    if (visited.has(id)) return
    visiting.add(id)
    for (const base of ancestry.get(id) ?? []) order(base)
    visiting.delete(id)
    visited.add(id)
    files.push(found.get(id)!)
  }
  for (const id of found.keys()) order(id)
  return {
    files,
    threadId,
    hasSubagents: containsSubagents,
    async verifySourceUnchanged() {
      for (const file of files)
        if (hash(await read(file.path)) !== hash(file.data))
          throw new Error(
            "Source session history changed during handoff; retry when idle",
          )
    },
  }
}

const script = `import sys,json,os,pathlib,base64,hashlib,tempfile,stat
r=json.load(sys.stdin);p=r['path'];data=base64.b64decode(r['data'])
if r['action']=='write':
 root=os.path.abspath(r['home'])
 if not os.path.isabs(root) or os.path.commonpath([root,os.path.abspath(p)])!=root:raise Exception('Invalid session import path')
 cur=root
 for part in os.path.relpath(os.path.dirname(p),root).split(os.sep):
  cur=os.path.join(cur,part)
  if os.path.islink(cur):raise Exception('Session import directory is a symlink')
  os.makedirs(cur,mode=448,exist_ok=True)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,384)
 with os.fdopen(fd,'wb') as f:f.write(data)
elif r['action']=='replace':
 expected=base64.b64decode(r['expected'])
 if os.path.islink(p) or not os.path.isfile(p):raise Exception('Session history is not a regular file')
 original=os.stat(p)
 if pathlib.Path(p).read_bytes()!=expected:raise Exception('Session history changed before replacement')
 fd,tmp=tempfile.mkstemp(prefix='.vimex-history-',dir=os.path.dirname(p))
 try:
  os.fchmod(fd,stat.S_IMODE(original.st_mode))
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  current=os.stat(p)
  if (current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns)!=(original.st_dev,original.st_ino,original.st_size,original.st_mtime_ns) or pathlib.Path(p).read_bytes()!=expected:raise Exception('Session history changed before replacement')
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
else:
 if os.path.lexists(p):
  if os.path.islink(p) or pathlib.Path(p).read_bytes()!=data:raise Exception('Imported history changed; retained for recovery: '+p)
  os.unlink(p)
`
async function mutate(host: MachineHost, request: Record<string, unknown>) {
  const result = await hostOperation(host, {
    action: "exec",
    cwd: "/",
    argv: ["python3", "-c", script],
    stdin: Buffer.from(JSON.stringify(request)).toString("base64"),
  })
  if (result.code !== 0)
    throw new Error(
      Buffer.from(result.stderr, "base64").toString("utf8").slice(-2048),
    )
}
export interface StagedHistoryBundle {
  createdIds: readonly string[]
  updatedIds: readonly string[]
  retain(): void
  paths: Map<string, string>
  cleanup(): Promise<void>
  verify(): Promise<void>
}
/** Complete histories may extend a proven inactive copy; divergent histories are never replaced. */
export async function stageHistoryBundle(
  bundle: HistoryBundle,
  destination: MachineHost,
  codexHome: string,
  locate: (id: string) => Promise<string | undefined>,
  options?: { authorizeUpdate?: (id: string, path: string) => Promise<void> },
): Promise<StagedHistoryBundle> {
  if (!posix.isAbsolute(codexHome))
    throw new Error("Destination app server did not report its Codex home")
  const paths = new Map<string, string>()
  const created: HistoryFile[] = []
  const updated: Array<HistoryFile & { previous: Buffer }> = []
  const reused: Array<{ path: string; data: Buffer }> = []
  let retained = false
  const cleanup = async () => {
    if (retained)
      throw new Error("Activated native histories were retained for recovery")
    // Retain the entire created closure if any file changed: a changed child
    // may still depend on every ancestor. Never delete its parents on failure.
    for (const file of [...created, ...updated, ...reused]) {
      const current = Buffer.from(
        (await hostOperation(destination, { action: "read", path: file.path }))
          .data,
        "base64",
      )
      if (!current.equals(file.data))
        throw new Error(
          "Imported native history changed; its ancestry was retained for recovery",
        )
    }
    for (const file of [...updated].reverse())
      await mutate(destination, {
        action: "replace",
        path: file.path,
        expected: file.data.toString("base64"),
        data: file.previous.toString("base64"),
      })
    for (const file of [...created].reverse())
      await mutate(destination, {
        action: "remove",
        path: file.path,
        data: file.data.toString("base64"),
      })
  }
  const verify = async () => {
    for (const file of bundle.files) {
      const data = Buffer.from(
        (
          await hostOperation(destination, {
            action: "read",
            path: paths.get(file.id)!,
          })
        ).data,
        "base64",
      )
      const required =
        file.complete || file.id === bundle.threadId
          ? file.data.length
          : file.requiredBytes
      if (
        data.length < required ||
        !data.subarray(0, required).equals(file.data.subarray(0, required))
      )
        throw new Error(`Destination native history differs for ${file.id}`)
    }
  }
  try {
    for (const file of bundle.files) {
      const existing = await locate(file.id)
      const path =
        existing ??
        posix.join(
          codexHome,
          "sessions",
          "2000",
          "01",
          "01",
          `rollout-2000-01-01T00-00-00-${file.id}.jsonl`,
        )
      paths.set(file.id, path)
      if (!existing) {
        await mutate(destination, {
          action: "write",
          home: codexHome,
          path,
          data: file.data.toString("base64"),
        })
        created.push({ ...file, path })
      } else {
        const data = Buffer.from(
          (await hostOperation(destination, { action: "read", path })).data,
          "base64",
        )
        const complete = file.complete || file.id === bundle.threadId
        if (
          complete &&
          data.length < file.data.length &&
          file.data.subarray(0, data.length).equals(data) &&
          options?.authorizeUpdate
        ) {
          validateLegacyRollout(data.toString("utf8"), file.id, true)
          await options.authorizeUpdate(file.id, path)
          await mutate(destination, {
            action: "replace",
            path,
            expected: data.toString("base64"),
            data: file.data.toString("base64"),
          })
          updated.push({ ...file, path, previous: data })
          continue
        }
        const required = complete ? file.data.length : file.requiredBytes
        if (
          data.length < required ||
          ((file.complete || file.id === bundle.threadId) &&
            data.length !== required) ||
          !data.subarray(0, required).equals(file.data.subarray(0, required))
        )
          throw new Error(
            `Destination already has different history for ${file.id}; nothing was overwritten`,
          )
        reused.push({ path, data })
      }
    }
    await verify()
    return {
      paths,
      createdIds: created.map((file) => file.id),
      updatedIds: updated.map((file) => file.id),
      retain() {
        retained = true
      },
      cleanup,
      verify,
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cause) {
      throw new AggregateError(
        [error, cause],
        "History import failed; recovery files were retained",
      )
    }
    throw error
  }
}

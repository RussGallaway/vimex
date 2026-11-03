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
}
export interface HistoryBundle {
  files: HistoryFile[]
  threadId: string
  verifySourceUnchanged(): Promise<void>
}

/** Native bytes are authoritative; paginated forks reference ancestor prefixes. */
export async function captureHistoryBundle(
  source: MachineHost,
  threadId: string,
  locate: (id: string) => Promise<string>,
): Promise<HistoryBundle> {
  const files: HistoryFile[] = []
  const visiting = new Set<string>()
  const found = new Map<string, HistoryFile>()
  let total = 0
  const read = async (path: string) =>
    Buffer.from(
      (await hostOperation(source, { action: "read", path })).data,
      "base64",
    )
  const visit = async (
    id: string,
    required?: { bytes: number; ordinal: number },
  ) => {
    if (!validId(id))
      throw new Error("Unsupported native history dependency ID")
    if (visiting.has(id))
      throw new Error("Native history contains a dependency cycle")
    const existing = found.get(id)
    if (existing) {
      if (required) {
        const prefix = existing.data.subarray(0, required.bytes)
        if (
          !Number.isSafeInteger(required.bytes) ||
          required.bytes <= 0 ||
          required.bytes > existing.data.length ||
          !Number.isSafeInteger(required.ordinal) ||
          required.ordinal < 1 ||
          prefix.at(-1) !== 10 ||
          ordinalAt(existing.data, required.bytes) !== required.ordinal
        )
          throw new Error(
            "Native history dependency has an invalid repeated cutoff",
          )
        if (required.bytes > existing.requiredBytes) {
          existing.requiredBytes = required.bytes
          existing.requiredOrdinal = required.ordinal
        }
      }
      return
    }
    if (found.size >= maxFiles)
      throw new Error("Session ancestry exceeds the 64-file handoff limit")
    visiting.add(id)
    const path = await locate(id)
    if (!posix.isAbsolute(path))
      throw new Error("Native history path must be absolute")
    const data = await read(path)
    total += data.length
    if (total > maxBytes)
      throw new Error("Session ancestry exceeds the 64 MiB handoff limit")
    validateLegacyRollout(data.toString("utf8"), id, true)
    const lines = data.toString("utf8").split("\n").filter(Boolean)
    if (required) {
      if (
        !Number.isSafeInteger(required.bytes) ||
        required.bytes <= 0 ||
        required.bytes > data.length ||
        !Number.isSafeInteger(required.ordinal) ||
        required.ordinal < 1
      )
        throw new Error("Native history dependency has an invalid cutoff")
      const prefix = data.subarray(0, required.bytes)
      if (
        prefix.at(-1) !== 10 ||
        ordinalAt(data, required.bytes) !== required.ordinal
      )
        throw new Error(
          "Native history dependency cutoff does not match its records",
        )
    }
    const file = {
      id,
      path,
      data,
      requiredBytes: required?.bytes ?? data.length,
      requiredOrdinal: required?.ordinal,
    }
    found.set(id, file)
    for (const line of lines) {
      const record = JSON.parse(line)
      if (record.type !== "session_meta") continue
      const base = record.payload?.history_base
      if (base) {
        if (
          typeof base.thread_id !== "string" ||
          typeof base.end_byte_offset !== "number" ||
          typeof base.end_ordinal_exclusive !== "number"
        )
          throw new Error(
            "Native history dependency lacks a portable byte/record cutoff",
          )
        await visit(base.thread_id, {
          bytes: base.end_byte_offset,
          ordinal: base.end_ordinal_exclusive,
        })
      }
    }
    visiting.delete(id)
    files.push(file)
  }
  await visit(threadId)
  return {
    files,
    threadId,
    async verifySourceUnchanged() {
      for (const file of files)
        if (hash(await read(file.path)) !== hash(file.data))
          throw new Error(
            "Source session history changed during handoff; retry when idle",
          )
    },
  }
}

const script = `import sys,json,os,pathlib,base64,hashlib
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
  paths: Map<string, string>
  cleanup(): Promise<void>
  verify(): Promise<void>
}
/** Never replace a preexisting ID. An ancestor may safely have a matching longer prefix. */
export async function stageHistoryBundle(
  bundle: HistoryBundle,
  destination: MachineHost,
  codexHome: string,
  locate: (id: string) => Promise<string | undefined>,
): Promise<StagedHistoryBundle> {
  if (!posix.isAbsolute(codexHome))
    throw new Error("Destination app server did not report its Codex home")
  const paths = new Map<string, string>()
  const created: HistoryFile[] = []
  const cleanup = async () => {
    // Retain the entire created closure if any file changed: a changed child
    // may still depend on every ancestor. Never delete its parents on failure.
    for (const file of created) {
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
        file.id === bundle.threadId ? file.data.length : file.requiredBytes
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
        const required =
          file.id === bundle.threadId ? file.data.length : file.requiredBytes
        if (
          data.length < required ||
          (file.id === bundle.threadId && data.length !== required) ||
          !data.subarray(0, required).equals(file.data.subarray(0, required))
        )
          throw new Error(
            `Destination already has different history for ${file.id}; nothing was overwritten`,
          )
      }
    }
    await verify()
    return {
      paths,
      createdIds: created.map((file) => file.id),
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

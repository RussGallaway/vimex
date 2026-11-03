import { hostOperation, type MachineHost } from "./host"

// Keep this private-store reader versioned: archived goals are unavailable through
// thread/goal/get. Never transfer goal state or return goal text to the caller.
const inspectGoals = `import sys,json,os,stat,sqlite3,pathlib
r=json.load(sys.stdin)
try:
 home=os.path.abspath(r['home'])
 if os.path.islink(home): raise Exception('Codex home must not be a symlink')
 if not os.path.isdir(home): raise Exception('Codex home is unavailable')
 stores=[n for n in os.listdir(home) if n.startswith('goals_') and n.endswith('.sqlite')]
 if any(n!='goals_1.sqlite' for n in stores): raise Exception('Unsupported Codex goal store version')
 p=os.path.join(home,'goals_1.sqlite')
 for suffix in ('','-wal','-shm','-journal'):
  candidate=p+suffix
  if os.path.lexists(candidate) and (os.path.islink(candidate) or not stat.S_ISREG(os.lstat(candidate).st_mode)):
   raise Exception('Codex goal store must use regular files without symlinks')
 if not os.path.exists(p):
  if any(os.path.lexists(p+s) for s in ('-wal','-shm','-journal')): raise Exception('Incomplete Codex goal store')
  print(json.dumps({'clear':True}));sys.exit(0)
 # mode=ro prevents database writes; query_only also forbids SQL mutation.
 # SQLite may update WAL shared-memory reader bookkeeping, never goal data.
 c=sqlite3.connect(pathlib.Path(p).as_uri()+'?mode=ro',uri=True,timeout=5)
 c.execute('PRAGMA query_only=ON')
 columns=c.execute('PRAGMA table_info(thread_goals)').fetchall()
 expected={'thread_id':'TEXT','goal_id':'TEXT','objective':'TEXT','status':'TEXT','token_budget':'INTEGER','tokens_used':'INTEGER','time_used_seconds':'INTEGER','created_at_ms':'INTEGER','updated_at_ms':'INTEGER'}
 if {row[1]:row[2].upper() for row in columns}!=expected or not any(row[1]=='thread_id' and row[5]==1 for row in columns):
  raise Exception('Unsupported Codex goal store schema')
 placeholders=','.join('?' for _ in r['ids'])
 exists=c.execute('SELECT 1 FROM thread_goals WHERE thread_id IN ('+placeholders+') LIMIT 1',r['ids']).fetchone() is not None
 c.close()
 if exists: raise Exception('Session tree has stored goal state; goal transfer is not available')
 print(json.dumps({'clear':True}))
except Exception as e:
 print(json.dumps({'error':str(e)}));sys.exit(1)
`

/** Refuse to silently drop goal state, including goals on archived descendants. */
export async function assertNoStoredGoals(
  host: Pick<MachineHost, "sshHost">,
  codexHome: string,
  ids: readonly string[],
  serverVersion: string,
): Promise<void> {
  if (serverVersion !== "0.166.0")
    throw new Error("Goal-store handoff checks require supported Codex 0.166.0")
  if (
    !codexHome ||
    !codexHome.startsWith("/") ||
    codexHome.includes("\0") ||
    ids.length > 64 ||
    ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
  )
    throw new Error("Invalid session-tree goal check")
  if (ids.length === 0) return
  const result = await hostOperation(host, {
    action: "exec",
    argv: ["python3", "-c", inspectGoals],
    stdin: Buffer.from(JSON.stringify({ home: codexHome, ids })).toString(
      "base64",
    ),
  })
  let response: { clear?: boolean; error?: string }
  try {
    response = JSON.parse(Buffer.from(result.stdout, "base64").toString("utf8"))
  } catch {
    throw new Error("Unable to inspect Codex goal store safely")
  }
  if (result.code !== 0 || response.clear !== true)
    throw new Error(
      response.error || "Unable to inspect Codex goal store safely",
    )
}

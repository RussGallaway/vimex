import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export interface MachineHost {
  sshHost?: string
  cwd: string
}
export interface HostCommandResult {
  stdout: Buffer
  stderr: Buffer
}

const marker = "VIMEX_HOST_RESULT:"
// A single framed JSON response keeps login banners separate from command data.
// stdin carries data, never shell source. No user string is interpolated into Python.
const python = `import sys,json,os,subprocess,base64,pathlib,shutil,tempfile
r=json.load(sys.stdin)
try:
 a=r['action']; p=r.get('path','')
 if a=='exec':
  e=os.environ.copy();e.update(r.get('env',{}));v=subprocess.run(r['argv'],cwd=r.get('cwd'),env=e,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=110)
  out={'code':v.returncode,'stdout':base64.b64encode(v.stdout).decode(),'stderr':base64.b64encode(v.stderr).decode()}
 elif a=='resolve':
  p=os.path.abspath(os.path.expanduser(p or '~'))
  if not os.path.isdir(p): raise Exception('Working directory does not exist: '+p)
  out={'path':os.path.realpath(p)}
 elif a=='read':
  if os.path.islink(p) or not os.path.isfile(p): raise Exception('Expected regular file: '+p)
  if os.path.getsize(p)>67108864: raise Exception('File exceeds 64 MiB transfer limit: '+p)
  out={'data':base64.b64encode(pathlib.Path(p).read_bytes()).decode(),'mode':os.stat(p).st_mode & 511}
 elif a=='write':
  pathlib.Path(p).parent.mkdir(parents=True,exist_ok=True)
  with open(p,'xb') as f:f.write(base64.b64decode(r['data']))
  os.chmod(p,r.get('mode',384));out={}
 elif a=='temp':out={'path':tempfile.mkdtemp(prefix='vimex-handoff-')}
 elif a=='transaction':
  base=os.path.join(os.environ.get('XDG_STATE_HOME',os.path.expanduser('~/.local/state')),'vimex','handoffs')
  os.makedirs(base,mode=448,exist_ok=True);p=os.path.join(base,r['id']);os.mkdir(p,448);out={'path':p}
 elif a=='remove':
  if os.path.isdir(p) and not os.path.islink(p):shutil.rmtree(p)
  elif os.path.lexists(p):os.unlink(p)
  out={}
 else:raise Exception('Unsupported host operation')
 print('${marker}'+json.dumps({'ok':True,'result':out}))
except Exception as e:print('${marker}'+json.dumps({'ok':False,'error':str(e)}));sys.exit(1)
`
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
function checkHost(host: string): void {
  if (!host || host.startsWith("-") || /[\s\0\r\n]/u.test(host))
    throw new Error("Invalid SSH host")
}
export async function hostOperation(
  host: Pick<MachineHost, "sshHost">,
  request: Record<string, unknown>,
): Promise<Record<string, any>> {
  if (host.sshHost) checkHost(host.sshHost)
  const command = host.sshHost ? "ssh" : "python3"
  const args = host.sshHost
    ? [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host.sshHost,
        `python3 -c ${quote(python)}`,
      ]
    : ["-c", python]
  const response = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Machine operation timed out"))
    }, 120_000)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 100 * 1024 * 1024) {
        child.kill()
        reject(new Error("Machine response exceeds transfer limit"))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", () => {
      clearTimeout(timer)
      const result = Buffer.concat(chunks).toString("utf8")
      if (!result.includes(marker))
        reject(new Error(`Machine operation failed: ${stderr.trim()}`))
      else resolve(result)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(request))
  })
  const lines = response
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(marker))
  if (lines.length !== 1) throw new Error("Invalid machine response framing")
  const decoded = JSON.parse(lines[0]!.slice(marker.length))
  if (!decoded.ok) throw new Error(decoded.error || "Machine operation failed")
  return decoded.result
}
export async function runHostCommand(
  host: MachineHost,
  argv: readonly string[],
  env?: Record<string, string>,
): Promise<HostCommandResult> {
  const result = await hostOperation(host, {
    action: "exec",
    cwd: host.cwd,
    argv,
    env,
  })
  const stdout = Buffer.from(result.stdout, "base64")
  const stderr = Buffer.from(result.stderr, "base64")
  if (result.code !== 0)
    throw new Error(
      `${argv[0]} failed (${result.code}): ${stderr.toString("utf8").slice(0, 4096)}`,
    )
  return { stdout, stderr }
}
export async function resolveMachineDirectory(
  sshHost: string,
  requested?: string,
): Promise<string> {
  return (
    await hostOperation({ sshHost }, { action: "resolve", path: requested })
  ).path
}
export async function createHostTransaction(
  host: MachineHost,
): Promise<string> {
  return (
    await hostOperation(host, { action: "transaction", id: randomUUID() })
  ).path
}

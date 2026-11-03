import { createHash } from "node:crypto"
import {
  hostOperation,
  runHostCommand,
  type MachineHost,
} from "@vimex/platform-node"
import type {
  HandoffDestination,
  HandoffDestinationListing,
} from "@vimex/workbench"
import type { MachineTarget } from "./machine-navigation"

type Request = {
  sourceId: string
  targetId: string
  cwd: string
  directory?: string
}
type Profile = { favorites: string[]; last?: string }
export type HandoffDestinationState = Record<string, Profile>
export function parseHandoffDestinationState(
  value: unknown,
): HandoffDestinationState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid handoff destination preferences")
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    )
      throw new Error("Invalid handoff destination profile")
    const profile = entry as Profile
    const validPath = (path: unknown) =>
      typeof path === "string" &&
      path.startsWith("/") &&
      !/[\x00-\x1f\x7f]/.test(path)
    if (
      !Array.isArray(profile.favorites) ||
      profile.favorites.length > 100 ||
      !profile.favorites.every(validPath) ||
      (profile.last !== undefined && !validPath(profile.last))
    )
      throw new Error("Invalid handoff destination paths")
  }
  return value as HandoffDestinationState
}

// Paths and origins are JSON data, never interpolated into Python or shell source.
// Only immediate child directories and at most 100 registered worktrees are inspected.
const inspectDirectories = `import os,sys,json,subprocess
r=json.loads(sys.argv[1]); base=os.path.realpath(os.path.expanduser(r['directory']))
if not os.path.isdir(base): raise Exception('Directory does not exist: '+base)
def git(path,*args):
 p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-C',path,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
 return p.stdout.decode('utf-8','replace').strip() if p.returncode==0 else None
def info(path):
 path=os.path.realpath(path)
 if not os.path.isdir(path) or any(ord(c)<32 or ord(c)==127 for c in path): return None
 root=git(path,'rev-parse','--show-toplevel') if os.path.lexists(os.path.join(path,'.git')) else None
 same=root is not None and os.path.realpath(root)==path and git(path,'remote','get-url','origin')==r['origin']
 v={'cwd':path,'label':os.path.basename(path) or path,'kind':'worktree' if same else 'directory'}
 if same:
  branch=git(path,'symbolic-ref','--quiet','--short','HEAD')
  if branch: v['branch']=branch
  v['dirty']=bool(git(path,'status','--porcelain','--untracked-files=normal'))
 return v
paths=[]
if r['browse']:
 paths=[base]
 count=0
 with os.scandir(base) as children:
  for child in children:
   count+=1
   if count>5000: raise Exception('Directory has too many entries; enter a more specific path')
   try:
    if child.is_dir(): paths.append(child.path)
   except OSError: pass
 if len(paths)>501: raise Exception('Directory has too many subdirectories; enter a more specific path')
else:
 paths=[base]+r['saved']
 for candidate in list(paths):
  if not os.path.isdir(candidate): continue
  listing=git(candidate,'worktree','list','--porcelain','-z')
  if listing:
   paths += [part[9:] for part in listing.split('\\0') if part.startswith('worktree ')][:100]
entries=[]; seen=set()
for path in paths:
 path=os.path.realpath(path)
 if path in seen: continue
 seen.add(path)
 v=info(path)
 if v and (r['browse'] or v['kind']=='worktree'): entries.append(v)
entries.sort(key=lambda v:(v['kind']!='worktree',v['label'].casefold(),v['cwd']))
print(json.dumps({'directory':base,'parent':os.path.dirname(base) if base!='/' else None,'entries':entries}))`

export function createHandoffDestinations(options: {
  target(id: string): MachineTarget
  directory(id: string): Promise<string>
  store: {
    read(fallback: HandoffDestinationState): Promise<HandoffDestinationState>
    write(state: HandoffDestinationState): Promise<void>
  }
}) {
  let state: HandoffDestinationState | undefined
  let mutations = Promise.resolve()
  let loading: Promise<HandoffDestinationState> | undefined
  const load = async () => {
    if (state) return state
    loading ??= options.store
      .read({})
      .then((loaded) => (state = loaded))
      .finally(() => {
        loading = undefined
      })
    return loading
  }
  const mutate = (operation: () => Promise<void>) => {
    const pending = mutations.catch(() => {}).then(operation)
    mutations = pending
    return pending
  }
  async function context(input: Request) {
    const source = options.target(input.sourceId)
    const target = options.target(input.targetId)
    const origin = (
      await runHostCommand({ sshHost: source.sshHost, cwd: input.cwd }, [
        "git",
        "remote",
        "get-url",
        "origin",
      ])
    ).stdout
      .toString("utf8")
      .trim()
    if (!origin) throw new Error("Source repository has no origin")
    const key = createHash("sha256")
      .update(
        JSON.stringify([input.targetId, target.sshHost ?? "local", origin]),
      )
      .digest("hex")
    const profile = (await load())[key] ?? { favorites: [] }
    return { target, origin, key, profile }
  }
  async function resolvePath(host: Pick<MachineHost, "sshHost">, path: string) {
    return (await hostOperation(host, { action: "resolve", path }))
      .path as string
  }
  async function inspect(
    host: Pick<MachineHost, "sshHost">,
    directory: string,
    origin: string,
    saved: string[],
    browse: boolean,
  ): Promise<HandoffDestinationListing> {
    const result = await runHostCommand({ ...host, cwd: directory }, [
      "python3",
      "-c",
      inspectDirectories,
      JSON.stringify({ directory, origin, saved, browse }),
    ])
    const parsed = JSON.parse(
      result.stdout.toString("utf8"),
    ) as HandoffDestinationListing & { parent?: string | null }
    return {
      directory: parsed.directory,
      ...(parsed.parent ? { parent: parsed.parent } : {}),
      entries: parsed.entries,
    }
  }
  async function canonicalExisting(
    input: Request & { destinationCwd: string },
  ) {
    const ctx = await context(input)
    const path = await resolvePath(ctx.target, input.destinationCwd)
    const listing = await inspect(ctx.target, path, ctx.origin, [], false)
    if (
      !listing.entries.some(
        (entry) => entry.cwd === path && entry.kind === "worktree",
      )
    )
      throw new Error("Choose a worktree root with the same repository origin")
    return { ...ctx, path }
  }
  return {
    async list(input: Request): Promise<HandoffDestinationListing> {
      const ctx = await context(input)
      let directory: string
      if (input.directory !== undefined)
        directory = await resolvePath(ctx.target, input.directory)
      else {
        // A configured cwd may have been removed after startup. Validate each
        // fallback before listing so saved prepared worktrees remain reachable.
        const configured = await options
          .directory(input.targetId)
          .catch(() => undefined)
        const candidates = [
          ...new Set(
            [
              ctx.profile.last,
              configured,
              ...ctx.profile.favorites,
              "~",
            ].filter((path): path is string => path !== undefined),
          ),
        ]
        let resolved: string | undefined
        let lastError: unknown
        for (const candidate of candidates) {
          try {
            resolved = await resolvePath(ctx.target, candidate)
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!resolved)
          throw lastError ?? new Error("No destination directory is available")
        directory = resolved
      }
      const result = await inspect(
        ctx.target,
        directory,
        ctx.origin,
        [
          ...ctx.profile.favorites,
          ...(ctx.profile.last ? [ctx.profile.last] : []),
        ],
        input.directory !== undefined,
      )
      const entries: HandoffDestination[] = result.entries.map((entry) => ({
        ...entry,
        ...(ctx.profile.favorites.includes(entry.cwd)
          ? { favorite: true }
          : {}),
      }))
      return {
        ...result,
        entries,
        ...(ctx.profile.last &&
        entries.some((entry) => entry.cwd === ctx.profile.last)
          ? { preferredCwd: ctx.profile.last }
          : {}),
      }
    },
    setFavorite(
      input: Request & { destinationCwd: string; favorite: boolean },
    ) {
      return mutate(async () => {
        const ctx = await canonicalExisting(input)
        const favorites = new Set(ctx.profile.favorites)
        if (input.favorite) favorites.add(ctx.path)
        else favorites.delete(ctx.path)
        const next = {
          ...(await load()),
          [ctx.key]: { ...ctx.profile, favorites: [...favorites] },
        }
        parseHandoffDestinationState(next)
        await options.store.write(next)
        state = next
      })
    },
    remember(input: Request & { destinationCwd: string }) {
      return mutate(async () => {
        const ctx = await canonicalExisting(input)
        const next = {
          ...(await load()),
          [ctx.key]: { ...ctx.profile, last: ctx.path },
        }
        parseHandoffDestinationState(next)
        await options.store.write(next)
        state = next
      })
    },
  }
}

import { runHostCommand } from "@vimex/platform-node"
import type { DirectoryNavigation, DirectoryListing } from "@vimex/workbench"
const inspect = `import os,sys,json
p=os.path.realpath(os.path.join(sys.argv[1],os.path.expanduser(sys.argv[2])))
if not os.path.isdir(p):raise Exception('Working directory does not exist or is not a directory: '+p)
rows=[]
if sys.argv[3]=='list':
 with os.scandir(p) as entries:
  for i,e in enumerate(entries):
   if i>=5000:break
   if e.is_dir():rows.append({'cwd':e.path,'label':e.name})
rows.sort(key=lambda e:e['label'].lower())
print(json.dumps({'directory':p,'parent':os.path.dirname(p) if p!='/' else None,'entries':rows[:500]}))`
export function createDirectoryNavigation(
  sshHost?: string,
): DirectoryNavigation {
  const read = async (
    base: string,
    path: string,
    mode: string,
  ): Promise<DirectoryListing> => {
    const result = await runHostCommand({ sshHost, cwd: "/" }, [
      "python3",
      "-c",
      inspect,
      base,
      path,
      mode,
    ])
    return JSON.parse(result.stdout.toString("utf8"))
  }
  return {
    resolve: async (base, path) =>
      (await read(base, path, "resolve")).directory,
    list: (base, path) => read(base, path, "list"),
  }
}

import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const pure = new Set(["conversation", "transcript", "composer", "interaction", "approvals", "workbench"])
const problems: string[] = []
async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "generated", ".git"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await visit(path); continue }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) continue
    const name = relative(root, path)
    const packageName = name.split("/")[1]
    const source = await readFile(path, "utf8")
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
      const target = match[1]!
      const violation = (reason: string) => problems.push(`${name}: ${reason}: ${target}`)
      if (pure.has(packageName!) && /^(?:react(?:\/|$)|zustand(?:\/|$)|@opentui\/|node:|bun(?:$|:)|@vimex\/(?:codex-app-server|platform-node|herdr|ui-opentui-react))/.test(target)) violation("pure domain imports a runtime adapter")
      if (target.includes("generated/") && packageName !== "codex-app-server") violation("Codex wire types escape the adapter")
      if (/^@vimex\/[^/]+\//.test(target)) violation("cross-package deep import")
      if (target.startsWith(".") && (name.startsWith("packages/") || name.startsWith("plugins/"))) {
        const targetPath = resolve(directory, target)
        const packageRoot = join(root, name.split("/")[0]!, packageName!)
        if (!targetPath.startsWith(packageRoot + "/")) violation("relative import escapes package")
      }
    }
  }
}
for (const folder of ["apps", "packages", "plugins"]) await visit(join(root, folder))
if (problems.length) {
  console.error(problems.join("\n"))
  process.exitCode = 1
} else console.log("Dependency boundaries verified")
